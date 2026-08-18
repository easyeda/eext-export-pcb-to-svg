/* eslint-disable style/max-statements-per-line, no-console */

/**
 * test/verify.cjs — 在 EDA 网桥内拦截 saveFile，触发 exportCurrentBoardToSvg，
 *                    把 ZIP 字节分块拉回本地，并校验 ZIP 顶层内容。
 *
 * 校验：
 *   1. ZIP 包含至少 5 个 SVG 文件
 *   2. 必须有 Top Copper.svg、Board Outline 或 Hole 层
 *   3. 每个 SVG 都以 <?xml 开头
 *
 * 用法：BRIDGE_PORT=49620 node test/verify.cjs
 */

const { Buffer } = require('node:buffer');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const process = require('node:process');
const JSZip = require('jszip');

const bridgePort = Number(process.env.BRIDGE_PORT || 49620);
const CHUNK_BYTES = 96 * 1024;
const OUT_DIR = path.join(__dirname, '..', 'verify-out');
const OUT_ZIP = path.join(OUT_DIR, 'verify-out.zip');

function execute(code) {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify({ code });
		const req = http.request({
			hostname: '127.0.0.1',
			port: bridgePort,
			path: '/execute',
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
		}, (res) => {
			let d = '';
			res.on('data', (c) => { d += c; });
			res.on('end', () => {
				try { resolve(JSON.parse(d)); }
				catch (e) { reject(e); }
			});
		});
		req.on('error', (e) => { reject(e); });
		req.write(body);
		req.end();
	});
}

const distJs = fs.readFileSync(path.join(__dirname, '..', 'dist/index.js'), 'utf-8');

const step1 = `${distJs}\n\n`
	+ `globalThis.__zipChunks = [];\n`
	+ `let captured = null;\n`
	+ `eda.sys_FileSystem = new Proxy(eda.sys_FileSystem, { get: (t, k) => { if (k !== 'saveFile') return t[k]; return async function(blob, name) { const buf = await blob.arrayBuffer(); const u8 = new Uint8Array(buf); globalThis.__zipChunks.push(Array.from(u8)); captured = { name, len: u8.length }; return true; }; } });\n`
	+ `try { await edaEsbuildExportName.exportCurrentBoardToSvg(); }\n`
	+ `catch (e) { captured = Object.assign(captured || {}, { err: String(e).slice(0, 400) }); }\n`
	+ `const total = globalThis.__zipChunks.reduce((a, c) => a + c.length, 0);\n`
	+ `return Object.assign({ chunks: globalThis.__zipChunks.length, total }, captured || {});\n`;

function makePullCode(start, end) {
	return `${distJs}\n\n`
		+ `const chunks = globalThis.__zipChunks || [];\n`
		+ `const flat = chunks.flat();\n`
		+ `const slice = flat.slice(${start}, ${end});\n`
		+ `return { len: slice.length, b64: btoa(String.fromCharCode.apply(null, slice)) };`;
}

let pass = 0;
let fail = 0;
function assert(cond, msg) {
	if (cond) {
		console.log('  ✓', msg);
		pass++;
		return;
	}
	console.error('  ✗', msg);
	fail++;
}

(async () => {
	console.log('--- step 1: exportCurrentBoardToSvg (intercept saveFile) ---');
	const r1 = await execute(step1);
	if (!r1.success) {
		console.error('STEP1 ERROR:', r1.error);
		process.exit(1);
	}
	console.log('STEP1:', JSON.stringify(r1.result));
	if (!r1.result || !r1.result.total || r1.result.err) {
		console.error('Export did not produce a ZIP or threw an error');
		process.exit(2);
	}

	const total = r1.result.total;
	const buf = Buffer.alloc(total);
	let offset = 0;
	let batch = 0;
	while (offset < total) {
		const end = Math.min(offset + CHUNK_BYTES, total);
		const r = await execute(makePullCode(offset, end));
		if (!r.success) {
			console.error('PULL ERROR:', r.error);
			process.exit(1);
		}
		const got = Buffer.from(r.result.b64, 'base64');
		got.copy(buf, offset);
		offset += got.length;
		batch++;
		console.log('batch', batch, ':', got.length, '/', offset, '/', total);
	}
	fs.mkdirSync(OUT_DIR, { recursive: true });
	fs.writeFileSync(OUT_ZIP, buf);
	console.log(`--- wrote ${OUT_ZIP} (${buf.length} bytes) ---\n`);

	const zip = await JSZip.loadAsync(buf);
	const svgFiles = Object.keys(zip.files).filter(n => !zip.files[n].dir && n.toLowerCase().endsWith('.svg'));
	const report = [];
	for (const n of svgFiles.sort()) {
		const text = await zip.files[n].async('string');
		const pathCount = (text.match(/<path /g) || []).length;
		report.push({ name: n, size: text.length, paths: pathCount });
	}
	console.table(report);

	console.log('--- assertions ---');
	assert(svgFiles.length >= 5, `ZIP contains ≥5 SVGs (got ${svgFiles.length})`);
	assert(svgFiles.some(n => /Gerber_TopLayer\.GTL\.svg$/i.test(n)), 'ZIP has Gerber_TopLayer.GTL.svg');
	assert(svgFiles.some(n => /Board Outline|\.GKO/i.test(n) || /Hole/i.test(n)), 'ZIP has either Board Outline or Hole layer');
	let allXml = true;
	for (const n of svgFiles) {
		const t = await zip.files[n].async('string');
		if (!t.trim().startsWith('<?xml')) {
			allXml = false;
			break;
		}
	}
	assert(allXml, 'all SVGs start with <?xml declaration');

	console.log(`\nverify: ${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
