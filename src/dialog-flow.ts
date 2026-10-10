/**
 * 对话框链式批量改名流程：可视化面板不可用时的回退路径。
 *
 * 背景：部分旧版本编辑器（实测 3.2.84）sys_IFrame.openIFrame 返回失败，
 * 原生对话框（showInputDialog/showSelectDialog）则不依赖该能力。
 * 本流程与面板功能等价：查找 → 替换 → 模式/大小写 → 预览确认 → 执行。
 */
import { applyRenamePlan, buildRenamePlan, collectNetLabels, type RenameOptions } from './netlabel';
import { askOption, askText, confirmBox, info, toast } from './ui';

const KIND_NAME: Record<string, string> = { netflag: '电源地', netport: '端口', wire: '导线', netlabel: '标签' };

export async function runDialogFlow(): Promise<void> {
	toast('当前编辑器无法打开可视化面板，已切换为对话框模式', false);

	// 1. 查找文本
	const find = await askText('批量修改网络标签', '查找内容（要被替换的网络名片段）：');
	if (find === null || find.length === 0)
		return;

	// 2. 替换文本
	const replace = await askText('批量修改网络标签', `将「${find}」替换为（留空表示删除该片段）：`);
	if (replace === null)
		return;

	// 3. 匹配模式
	const mode = await askOption('批量修改网络标签', '匹配模式：', [
		{ value: 'plain', displayContent: '普通文本（包含即替换）' },
		{ value: 'regex', displayContent: '正则表达式（替换文本支持 $1 捕获组）' },
	]);
	if (mode === null)
		return;
	if (mode === 'regex') {
		try {
			void new RegExp(find);
		}
		catch {
			info('正则表达式语法错误，请检查后重试。', '批量修改网络标签');
			return;
		}
	}

	// 4. 大小写
	const caseOpt = await askOption('批量修改网络标签', '大小写匹配：', [
		{ value: 'no', displayContent: '不区分大小写' },
		{ value: 'yes', displayContent: '区分大小写' },
	]);
	if (caseOpt === null)
		return;

	const opts: RenameOptions = { find, replace, mode: mode === 'regex' ? 'regex' : 'plain', caseSensitive: caseOpt === 'yes' };

	// 5. 采集 + 生成计划
	const { items } = await collectNetLabels();
	const { plan, skippedEmpty } = buildRenamePlan(items, opts);
	if (plan.length === 0) {
		info(`没有匹配「${find}」的网络对象（共扫描 ${items.length} 个图元）。`, '批量修改网络标签');
		return;
	}

	// 6. 预览确认（按 旧名→新名 聚合，避免同网络多导线刷屏）
	const agg = new Map<string, number>();
	for (const p of plan) {
		const k = `${KIND_NAME[p.item.kind] ?? p.item.kind}\t${p.from}\t${p.to}`;
		agg.set(k, (agg.get(k) ?? 0) + 1);
	}
	const pairs = [...agg.entries()].slice(0, 20).map(([k, n]) => {
		const [, from, to] = k.split('\t');
		return n > 1 ? `${from} → ${to}（${n} 个图元）` : `${from} → ${to}`;
	});
	const more = agg.size > 20 ? `\n…（其余 ${agg.size - 20} 组省略）` : '';
	const emptyNote = skippedEmpty > 0 ? `\n\n另有 ${skippedEmpty} 条替换后为空名，已自动跳过。` : '';
	const ok = await confirmBox(
		`将修改 ${plan.length} 个图元的网络名：\n\n${pairs.join('\n')}${more}${emptyNote}\n\n确认执行？`,
		'批量修改网络标签',
		'执行',
		'取消',
	);
	if (!ok)
		return;

	// 7. 应用
	const outcome = await applyRenamePlan(plan);
	const failLines = outcome.failures.slice(0, 8).map(f => `${f.from} → ${f.to}：${f.reason}`).join('\n');
	info(
		`完成：成功 ${outcome.okCount} 个，失败 ${outcome.failCount} 个。${failLines ? `\n\n${failLines}` : ''}\n\n`
		+ '改名不会自动保存工程，请检查画布后手动保存。',
		'批量修改网络标签',
	);
}
