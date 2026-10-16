/** Follow the keyboard-reduced viewport without rebuilding dialog contents. */
export function trackVisibleViewport(element: HTMLElement): () => void {
	const win = element.ownerDocument?.defaultView;
	if (!win) return () => {};
	const viewport = win.visualViewport;
	const update = () => {
		element.style.setProperty(
			"--filen-viewport-height",
			`${viewport?.height ?? win.innerHeight}px`,
		);
		element.style.setProperty(
			"--filen-viewport-width",
			`${viewport?.width ?? win.innerWidth}px`,
		);
		element.style.setProperty("--filen-viewport-top", `${viewport?.offsetTop ?? 0}px`);
		element.style.setProperty("--filen-viewport-left", `${viewport?.offsetLeft ?? 0}px`);
	};
	update();
	win.addEventListener("resize", update);
	viewport?.addEventListener("resize", update);
	viewport?.addEventListener("scroll", update);
	return () => {
		win.removeEventListener("resize", update);
		viewport?.removeEventListener("resize", update);
		viewport?.removeEventListener("scroll", update);
		for (const name of ["height", "width", "top", "left"])
			element.style.removeProperty(`--filen-viewport-${name}`);
	};
}
