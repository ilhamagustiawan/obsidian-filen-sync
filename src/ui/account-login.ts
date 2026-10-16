import { Setting, type TextComponent } from "obsidian";
import type FilenSyncPlugin from "../main";

export function configureLoginInput(
	input: HTMLInputElement,
	kind: "email" | "password" | "code",
): void {
	input.name = kind === "code" ? "filen-two-factor-code" : `filen-${kind}`;
	input.type = kind === "password" ? "password" : kind === "email" ? "email" : "text";
	input.autocomplete =
		kind === "email" ? "username" : kind === "password" ? "current-password" : "one-time-code";
	input.inputMode = kind === "code" ? "numeric" : kind === "email" ? "email" : "text";
	input.setAttribute("autocapitalize", "none");
	input.setAttribute("autocorrect", "off");
	input.spellcheck = false;
	input.setAttribute(
		"aria-label",
		kind === "code" ? "Two-factor code" : kind === "email" ? "Email" : "Password",
	);
}

export function renderAccountLogin(
	section: HTMLElement,
	plugin: FilenSyncPlugin,
	onConnected: () => void,
): void {
	new Setting(section)
		.setName("Email")
		.setDesc("Filen account email.")
		.addText((text) => {
			configureLoginInput(text.inputEl, "email");
			text.setPlaceholder("name@example.com")
				.setValue(plugin.settings.email)
				.onChange(async (value) => {
					plugin.settings.email = value.trim();
					await plugin.saveSettings();
					void plugin.refreshSyncTarget();
				});
		});
	let password: TextComponent;
	new Setting(section)
		.setName("Password")
		.setDesc("Not stored.")
		.addText((text) => {
			password = text;
			configureLoginInput(text.inputEl, "password");
			text.setPlaceholder(plugin.hasSessionPassword() ? "••••••••" : "Password").onChange(
				(value) => {
					plugin.setSessionPassword(value);
				},
			);
		})
		.addButton((button) => {
			button.setButtonText("Show password").onClick(() => {
				const show = password.inputEl.type === "password";
				password.inputEl.type = show ? "text" : "password";
				button.setButtonText(show ? "Hide password" : "Show password");
				button.buttonEl.setAttribute("aria-pressed", String(show));
			});
			button.buttonEl.setAttribute("aria-pressed", "false");
		});
	new Setting(section)
		.setName("Two-factor code")
		.setDesc("If enabled.")
		.addText((text) => {
			configureLoginInput(text.inputEl, "code");
			text.setPlaceholder("123456").onChange((value) => {
				plugin.setSessionTwoFactorCode(value.trim());
			});
		});
	const login = new Setting(section).setName("Login").setDesc("Connect to Filen.");
	const feedback = section.createEl("p", { cls: "filen-login-feedback" });
	feedback.setAttribute("role", "status");
	feedback.setAttribute("aria-live", "polite");
	let busy = false;
	login.addButton((button) => {
		button
			.setButtonText("Login")
			.setCta()
			.onClick(async () => {
				if (busy) return;
				busy = true;
				button.setDisabled(true).setButtonText("Connecting…");
				feedback.setText("Connecting to Filen…");
				feedback.removeClass("is-error");
				try {
					const connected = await plugin.testConnection();
					if (!feedback.isConnected) return;
					if (connected) onConnected();
					else {
						feedback.setText(
							"Could not connect. Check your connection, email, password, and two-factor code, then try again.",
						);
						feedback.addClass("is-error");
					}
				} catch (error) {
					if (feedback.isConnected) {
						feedback.setText(
							error instanceof Error
								? error.message
								: "Could not connect. Try again.",
						);
						feedback.addClass("is-error");
					}
				} finally {
					busy = false;
					button.setDisabled(false).setButtonText("Login");
				}
			});
	});
}
