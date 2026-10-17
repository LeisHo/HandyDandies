// Vercel serverless function behind the dev panel's "Saved Dev Settings" list (2026-10-15, direct request: the saved items must be the same on desktop and mobile). The items used to live in each browser's own
// localStorage, so a phone started with an empty list. They now live in this repo, one JSON file per item under data/processed/saved-states/ (a small _default.json holds which item is the default), written through
// GitHub's Contents API exactly like api/save-settings.js writes the live settings, with the same environment variables:
//   GITHUB_TOKEN            - fine-grained PAT, contents:read+write on this repo
//   DEV_PANEL_SAVE_SECRET   - shared anti-abuse token; must match the client's copy (POST only)
// Optional: GITHUB_REPO ("owner/repo", default LeisHo/HandyDandies), GITHUB_BRANCH (default main), SAVED_STATES_DIR (default data/processed/saved-states)
//
//   GET                 -> { ok, names: [...], default: "name" | "" }
//   GET ?name=X         -> { ok, state: <the stored item> }
//   POST { name, state }-> create / overwrite item X
//   POST { default: X } -> make X the default ("" clears it)
//   POST { delete: X }  -> delete item X

const DEFAULT_REPO = 'LeisHo/HandyDandies';
const DEFAULT_BRANCH = 'main';
const DEFAULT_DIR = 'data/processed/saved-states';
const DEFAULT_FILE = '_default.json';
const MAX_NAME = 120;

module.exports = async (req, res) => {
    if (req.method !== 'POST' && req.method !== 'GET') {
        res.status(405).json({ ok: false, error: 'Method not allowed' });
        return;
    }
    const token = process.env.GITHUB_TOKEN;
    const secret = process.env.DEV_PANEL_SAVE_SECRET;
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
    const dir = (process.env.SAVED_STATES_DIR || DEFAULT_DIR).replace(/\/+$/, '');
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
    };
    const urlFor = (path) => `https://api.github.com/repos/${repo}/contents/${path}`;
    const fileFor = (name) => `${dir}/${encodeURIComponent(name)}.json`;
    const refQ = `?ref=${encodeURIComponent(branch)}`;

    // The file's current sha, or undefined when it does not exist yet.
    async function shaOf(path) {
        const r = await fetch(urlFor(path) + refQ, { headers, cache: 'no-store' });
        if (r.status === 404) return undefined;
        if (!r.ok) throw new Error(`GitHub lookup failed (${r.status}): ${await r.text()}`);
        const j = await r.json();
        return j.sha;
    }
    async function readRaw(path) {
        const r = await fetch(urlFor(path) + refQ, { headers: { ...headers, Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`GitHub read failed (${r.status}): ${await r.text()}`);
        return r.text();
    }
    async function writeFile(path, obj, message) {
        const sha = await shaOf(path);
        const content = Buffer.from(JSON.stringify(obj) + '\n', 'utf-8').toString('base64');
        const r = await fetch(urlFor(path), { method: 'PUT', headers, body: JSON.stringify({ message, content, branch, ...(sha ? { sha } : {}) }) });
        if (!r.ok) throw new Error(`GitHub commit failed (${r.status}): ${await r.text()}`);
    }
    async function deleteFile(path, message) {
        const sha = await shaOf(path);
        if (!sha) return;
        const r = await fetch(urlFor(path), { method: 'DELETE', headers, body: JSON.stringify({ message, sha, branch }) });
        if (!r.ok) throw new Error(`GitHub delete failed (${r.status}): ${await r.text()}`);
    }
    const badName = (n) => typeof n !== 'string' || !n.trim() || n.length > MAX_NAME;

    try {
        if (req.method === 'GET') {
            res.setHeader('Cache-Control', 'no-store');
            const wanted = req.query && req.query.name;
            if (wanted !== undefined) {
                if (badName(wanted)) { res.status(400).json({ ok: false, error: 'Bad name' }); return; }
                const text = await readRaw(fileFor(wanted));
                if (text === null) { res.status(404).json({ ok: false, error: 'No such saved setting' }); return; }
                res.status(200).json({ ok: true, state: JSON.parse(text) });
                return;
            }
            const listResp = await fetch(urlFor(dir) + refQ, { headers, cache: 'no-store' });
            let names = [];
            if (listResp.ok) {
                const items = await listResp.json();
                names = (Array.isArray(items) ? items : [])
                    .filter((f) => f.type === 'file' && f.name.endsWith('.json') && f.name !== DEFAULT_FILE)
                    .map((f) => { try { return decodeURIComponent(f.name.slice(0, -5)); } catch (e) { return f.name.slice(0, -5); } });
            } else if (listResp.status !== 404) {
                res.status(502).json({ ok: false, error: `GitHub list failed (${listResp.status}): ${await listResp.text()}` });
                return;
            }
            let def = '';
            const defText = await readRaw(`${dir}/${DEFAULT_FILE}`);
            if (defText) { try { def = String(JSON.parse(defText).default || ''); } catch (e) { def = ''; } }
            res.status(200).json({ ok: true, names, default: names.includes(def) ? def : '' });
            return;
        }

        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) { res.status(400).json({ ok: false, error: 'Body must be a JSON object' }); return; }
        if (typeof body.delete === 'string') {
            if (badName(body.delete)) { res.status(400).json({ ok: false, error: 'Bad name' }); return; }
            await deleteFile(fileFor(body.delete), `Delete saved dev setting "${body.delete}"`);
            res.status(200).json({ ok: true });
            return;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'default')) {
            const d = String(body.default || '');
            if (d && badName(d)) { res.status(400).json({ ok: false, error: 'Bad name' }); return; }
            await writeFile(`${dir}/${DEFAULT_FILE}`, { default: d }, 'Set default saved dev setting');
            res.status(200).json({ ok: true });
            return;
        }
        if (badName(body.name) || !body.state || typeof body.state !== 'object') { res.status(400).json({ ok: false, error: 'Needs { name, state }' }); return; }
        await writeFile(fileFor(body.name), body.state, `Save dev setting "${body.name}"`);
        res.status(200).json({ ok: true });
    } catch (err) {
        res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
};
