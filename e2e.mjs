/**
 * sch-net-tools 端到端 UI 验证驱动
 * 用法：node e2e.mjs <eext路径> <find> <replace> <expectContains>
 * 流程：部署 → 修 isShowAtHeaderMenu → 刷新 → 菜单流程（查找/替换/模式/大小写/预览执行/结果）→ 输出验证
 */
import WebSocket from 'ws';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const CDP_HTTP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USER_UUID = 'cda02836c38f4bf0a41acc34a333862f';
const DB_NAME = `User_${USER_UUID}_v6`;

const [, , eextPath, findText_, replaceText_] = process.argv;
if (!eextPath || !findText_ || !replaceText_) {
	console.error('用法: node e2e.mjs <eext路径> <查找> <替换>');
	process.exit(1);
}
if (!existsSync(eextPath)) {
	console.error('eext 不存在:', eextPath);
	process.exit(1);
}

function connect(wsUrl) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		let id = 0;
		const pending = new Map();
		ws.on('open', () => resolve({
			send(method, params = {}) {
				return new Promise((res2, rej2) => {
					const msgId = ++id;
					pending.set(msgId, { res: res2, rej: rej2 });
					ws.send(JSON.stringify({ id: msgId, method, params }));
				});
			},
			close: () => ws.close(),
		}));
		ws.on('message', (d) => {
			const m = JSON.parse(d.toString());
			if (m.id && pending.has(m.id)) {
				const p = pending.get(m.id);
				pending.delete(m.id);
				m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
			}
		});
		ws.on('error', reject);
	});
}

async function withPage(fn) {
	const res = await fetch(`${CDP_HTTP}/json`);
	const targets = await res.json();
	const page = targets.find((t) => t.type === 'page' && /editor/.test(t.url)) ?? targets.find((t) => t.type === 'page');
	if (!page) throw new Error('未找到编辑器页面');
	const cdp = await connect(page.webSocketDebuggerUrl);
	try {
		return await fn(cdp);
	}
	finally {
		cdp.close();
	}
}

async function evalJs(cdp, expression) {
	await cdp.send('Runtime.enable');
	const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
	return r.result.value;
}

async function click(cdp, x, y) {
	await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
	await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
	await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

const findText = (cdp, text, exact = true) => evalJs(cdp, `(() => {
	for (const el of document.querySelectorAll('div,span,li,button')) {
		const t = (el.textContent || '').trim();
		if ((${exact ? 't === ' + JSON.stringify(text) : 't.includes(' + JSON.stringify(text) + ')' }) && el.children.length === 0) {
			const r = el.getBoundingClientRect();
			if (r.width > 0) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
		}
	}
	return null;
})()`);

const clickText = async (cdp, text, exact = true) => {
	const p = await findText(cdp, text, exact);
	if (!p) throw new Error(`未找到文本: ${text}`);
	await click(cdp, p.x, p.y);
	return p;
};

/** 弹窗输入：点最后一个可见 input，Ctrl+A 全选后输入（覆盖任何默认值） */
async function fillDialogInput(cdp, text) {
	const box = await evalJs(cdp, `(() => {
		const all = [...document.querySelectorAll('input')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 50 && r.height > 10; });
		if (!all.length) return null;
		const el = all[all.length - 1];
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
	})()`);
	if (!box) throw new Error('弹窗输入框未找到');
	await click(cdp, box.x, box.y);
	await sleep(150);
	await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
	await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
	await cdp.send('Input.insertText', { text });
	await sleep(250);
}

const confirmDialog = async (cdp, label = '') => {
	await clickText(cdp, '确认');
	await sleep(900);
	console.log(`  [ok] 确认 ${label}`);
};

async function main() {
	// 1. 构建产物检查
	const size = readFileSync(eextPath).length;
	console.log(`[1] eext: ${eextPath} (${size} bytes)`);

	await withPage(async (cdp) => {
		// 2. 部署：高级 → 扩展管理器 → 导入（file input 注入）
		console.log('[2] 部署扩展...');
		await clickText(cdp, '高级');
		await sleep(600);
		await clickText(cdp, '扩展管理器', false);
		await sleep(1400);
		await cdp.send('DOM.enable');
		const doc = await cdp.send('DOM.getDocument');
		const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
		if (!nodeIds.length) throw new Error('file input 未找到');
		await cdp.send('DOM.setFileInputFiles', { files: [eextPath], nodeId: nodeIds[0] });
		await sleep(1500);
		const confirmBtn = await findText(cdp, '确认');
		if (confirmBtn) { await click(cdp, confirmBtn.x, confirmBtn.y); await sleep(600); }
		const closeBtn = await findText(cdp, '关闭');
		if (closeBtn) { await click(cdp, closeBtn.x, closeBtn.y); await sleep(600); }

		// 3. 修 isShowAtHeaderMenu（覆盖安装可能重置）
		await evalJs(cdp, `(async () => {
			const db = await new Promise((res, rej) => { const r = indexedDB.open('${DB_NAME}'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
			const uuid = '4a2520cbd227438b801cd4b61e56cefc';
			const rec = await new Promise((res) => { const r = db.transaction('extensionsIndex','readonly').objectStore('extensionsIndex').get(uuid); r.onsuccess = () => res(r.result); });
			if (rec && !rec.isShowAtHeaderMenu) {
				rec.isShowAtHeaderMenu = true;
				await new Promise((res, rej) => { const r = db.transaction('extensionsIndex','readwrite').objectStore('extensionsIndex').put(rec); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
			}
			db.close();
			return 'db-ok';
		})()`);

		// 4. 刷新页面（重载扩展运行时 + 注册菜单）
		console.log('[3] 刷新编辑器...');
		await cdp.send('Page.enable');
		await cdp.send('Page.reload');
		await sleep(16000);

		// 5. UI 流程
		console.log(`[4] 菜单流程: ${findText_} → ${replaceText_}`);
		await clickText(cdp, '网络工具');
		await sleep(700);
		await clickText(cdp, '批量修改网络标签名称', false);
		await sleep(900);
		await fillDialogInput(cdp, findText_);
		await confirmDialog(cdp, '查找内容');
		await fillDialogInput(cdp, replaceText_);
		await confirmDialog(cdp, '替换为');
		await confirmDialog(cdp, '匹配模式');
		await confirmDialog(cdp, '大小写');
		await sleep(400);

		// 6. 读预览内容
		const preview = await evalJs(cdp, `(() => {
			for (const el of document.querySelectorAll('div')) {
				const t = (el.textContent || '');
				if (t.includes('将修改') && t.includes('确认执行')) return t.trim();
			}
			return null;
		})()`);
		console.log('=== 预览内容 ===');
		console.log(preview ?? '(未找到预览)');
		if (!preview) throw new Error('预览弹窗未出现');

		// 7. 执行
		await clickText(cdp, '执行');
		await sleep(1500);
		const result = await evalJs(cdp, `(() => {
			for (const el of document.querySelectorAll('div')) {
				const t = (el.textContent || '');
				if (t.includes('完成：成功')) return t.trim();
			}
			return null;
		})()`);
		console.log('=== 执行结果 ===');
		console.log(result ?? '(结果弹窗未找到)');

		// 关闭结果弹窗（确定按钮）
		const okBtn = await findText(cdp, '确定');
		if (okBtn) { await click(cdp, okBtn.x, okBtn.y); await sleep(500); }
	});

	console.log('[done] E2E 完成');
}

main().catch((e) => {
	console.error('[e2e] 失败:', e.message);
	process.exit(1);
});
