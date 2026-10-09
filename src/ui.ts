/** 对话框交互封装：把 EDA 的弹窗 API 包装成 Promise，兼容「同步返回值」与「回调」两种行为 */

/** 防止回调与同步返回值重复 resolve */
function once<T>(fn: (v: T) => void): (v: T) => void {
	let called = false;
	return (v: T) => {
		if (called)
			return;
		called = true;
		fn(v);
	};
}

/** 文本输入框；用户取消返回 null */
export function askText(title: string, prompt: string, defaultValue = ''): Promise<string | null> {
	return new Promise((resolve) => {
		const done = once((v: unknown) => resolve(typeof v === 'string' ? v : null));
		const r = eda.sys_Dialog.showInputDialog(
			prompt,
			'',
			title,
			'text',
			defaultValue,
			{},
			done as (value: any) => void,
		);
		if (typeof r === 'string')
			done(r);
	});
}

/** 单选框；用户取消返回 null */
export function askOption(
	title: string,
	prompt: string,
	options: Array<{ value: string; displayContent: string }>,
): Promise<string | null> {
	return new Promise((resolve) => {
		const done = once((v: unknown) => resolve(typeof v === 'string' ? v : null));
		const r = eda.sys_Dialog.showSelectDialog(
			options,
			prompt,
			'',
			title,
			options[0]?.value,
			false,
			done as (value: any) => void,
		);
		if (typeof r === 'string')
			done(r);
	});
}

/** 确认框；返回是否点击了主按钮 */
export function confirmBox(message: string, title: string, okLabel = '执行', cancelLabel = '取消'): Promise<boolean> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showConfirmationMessage(message, title, okLabel, cancelLabel, (mainClicked: boolean) => resolve(!!mainClicked));
	});
}

/** 信息框 */
export function info(message: string, title: string): void {
	eda.sys_Dialog.showInformationMessage(message, title);
}

/** 右下角 toast */
export function toast(message: string, ok: boolean): void {
	eda.sys_ToastMessage.showMessage(message, ok ? ESYS_ToastMessageType.SUCCESS : ESYS_ToastMessageType.ERROR);
}
