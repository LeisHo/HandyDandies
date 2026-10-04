// Vercel serverless function backing the dev panel's Save/Reset buttons
// (CLAUDE.md Section 12l). Ported near-verbatim from HANDO's own
// api/save-settings.js (direct request: "look at hando and see how the
// save button saves dev panel settings to git. Implement.") -- same
// mechanism, same env var names, only the repo/branch defaults changed to
// this project's own. POST commits the posted settings dump to
// data/processed/dev-panel-settings.json in this repo via GitHub's
// Contents API, so any device/browser sees the same saved state (not just
// the one that clicked Save -- this project's own devPanel.js previously
// had no shared persistence at all, only per-browser localStorage). GET
// reads that same file back LIVE from the Contents API rather than the
// same-origin static file, which only reflects whatever was live at the
// LAST Vercel deployment -- a Save right after a deploy would otherwise be
// invisible on refresh until the next redeploy.
//
// Required Vercel project environment variables (see README.md for setup):
//   GITHUB_TOKEN            - fine-grained PAT, contents:read+write on this repo
//   DEV_PANEL_SAVE_SECRET   - shared anti-abuse token; must match the client's copy (POST only -- GET is a read, no write capability to protect)
// Optional (defaulted below):
//   GITHUB_REPO             - "owner/repo", defaults to "LeisHo/HandyDandies"
//   GITHUB_BRANCH           - defaults to "main" (this repo's actual branch)
//   SETTINGS_FILE_PATH      - defaults to "data/processed/dev-panel-settings.json"

const DEFAULT_REPO = 'LeisHo/HandyDandies';
const DEFAULT_BRANCH = 'main';
const DEFAULT_PATH = 'data/processed/dev-panel-settings.json';

module.exports = async (req, res) => {
    if (req.method !== 'POST' && req.method !== 'GET') {
        res.status(405).json({ ok: false, error: 'Method not allowed' });
        return;
    }

    const token = process.env.GITHUB_TOKEN;
    const secret = process.env.DEV_PANEL_SAVE_SECRET;
    // Report exactly which var is missing, not a vague "one of these" --
    // DEV_PANEL_SAVE_SECRET only gates POST (a write) -- GET is a read with
    // no write capability to protect, so it only needs GITHUB_TOKEN.
    const missing = [];
    if (!token) missing.push('GITHUB_TOKEN');
    if (req.method === 'POST' && !secret) missing.push('DEV_PANEL_SAVE_SECRET');
    if (missing.length) {
        res.status(500).json({ ok: false, error: `Server not configured - missing: ${missing.join(', ')}` });
        return;
    }
    if (req.method === 'POST' && req.headers['x-dev-panel-secret'] !== secret) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
    }

    const repo = process.env.GITHUB_REPO || DEFAULT_REPO;
    const branch = process.env.GITHUB_BRANCH || DEFAULT_BRANCH;
    const path = process.env.SETTINGS_FILE_PATH || DEFAULT_PATH;
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}`;
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
    };

    if (req.method === 'GET') {
        try {
            const getResp = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers, cache: 'no-store' });
            if (getResp.status === 404) {
                res.status(200).json({ ok: true, settings: null }); // nothing saved yet -- not an error
                return;
            }
            if (!getResp.ok) {
                const errText = await getResp.text();
                res.status(502).json({ ok: false, error: `GitHub lookup failed (${getResp.status}): ${errText}` });
                return;
            }
            const getData = await getResp.json();
            // CORRECTED 2026-09-27 -- real production outage, confirmed live
            // on handy-dandies.vercel.app: GitHub's Contents API only
            // inlines a file's `content` field for files <= ~1MB; above
            // that (this file crossed 1.2MB from months of Save/Sync
            // accumulation) `content` comes back empty while `sha`/`size`/
            // `download_url` are still present. `JSON.parse('')` on the
            // empty fallback threw "Unexpected end of JSON input" on EVERY
            // GET, permanently 500ing the dev panel's own settings restore
            // -- the live app fell back to its 6-second hardcoded-defaults
            // timeout on every load (white background, empty custom click
            // functions, default camera), which read as "everything is
            // broken" even though no application code was actually at
            // fault. Fixed by falling back to `download_url` (a raw
            // githubusercontent.com URL GitHub always provides regardless
            // of size, up to 100MB) whenever `content` is missing/empty.
            let jsonText;
            if (getData.content) {
                jsonText = Buffer.from(getData.content, 'base64').toString('utf-8');
            } else if (getData.sha) {
                // CORRECTED 2026-10-04 -- the 2026-09-27 fallback above fetched
                // `download_url`, which is raw.githubusercontent.com and is CDN-
                // cached for ~5 minutes, so a reload shortly after a Save served the
                // PREVIOUS file (confirmed: the endpoint returned
                // loadingPreviewShowLive=true while the repo's latest commit had
                // false), which read as "the setting isn't saving" and let the next
                // Save write the stale values back. The Contents API with the raw
                // media type returns the same fresh data as the metadata call (up
                // to 100MB) with no CDN in between.
                const rawResp = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, {
                    headers: { ...headers, Accept: 'application/vnd.github.raw+json' },
                    cache: 'no-store',
                });
                if (!rawResp.ok) {
                    const errText = await rawResp.text();
                    res.status(502).json({ ok: false, error: `GitHub raw content fetch failed (${rawResp.status}): ${errText}` });
                    return;
                }
                jsonText = await rawResp.text();
            } else {
                jsonText = '';
            }
            res.setHeader('Cache-Control', 'no-store');
            res.status(200).json({ ok: true, settings: jsonText ? JSON.parse(jsonText) : null });
        } catch (err) {
            res.status(500).json({ ok: false, error: String((err && err.message) || err) });
        }
        return;
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({ ok: false, error: 'Body must be a JSON object' });
        return;
    }

    try {
        // Current file's sha is required to update an existing file (absent
        // entirely for a brand-new file -- a 404 here just means "create").
        let sha;
        const getResp = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
        if (getResp.ok) {
            const getData = await getResp.json();
            sha = getData.sha;
        } else if (getResp.status !== 404) {
            const errText = await getResp.text();
            res.status(502).json({ ok: false, error: `GitHub lookup failed (${getResp.status}): ${errText}` });
            return;
        }

        const content = Buffer.from(JSON.stringify(body, null, 2) + '\n', 'utf-8').toString('base64');
        const putResp = await fetch(apiUrl, {
            method: 'PUT',
            headers,
            body: JSON.stringify({
                message: 'Update dev-panel-settings.json via Save Settings',
                content,
                branch,
                ...(sha ? { sha } : {}),
            }),
        });

        if (!putResp.ok) {
            const errText = await putResp.text();
            res.status(502).json({ ok: false, error: `GitHub commit failed (${putResp.status}): ${errText}` });
            return;
        }

        const putData = await putResp.json();
        res.status(200).json({ ok: true, commitSha: putData.commit && putData.commit.sha });
    } catch (err) {
        res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
};
