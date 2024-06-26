import { Extension } from "@codemirror/state";
import { Plugin, Notice, loadMathJax, addIcon } from "obsidian";
import { onFileCreate, onFileChange, onFileDelete, getSnippetsFromFiles, getFileSets, getVariablesFromFiles, tryGetVariablesFromUnknownFiles } from "./settings/file_watch";
import { LatexSuitePluginSettings, DEFAULT_SETTINGS, LatexSuiteCMSettings, processLatexSuiteSettings } from "./settings/settings";
import { LatexSuiteSettingTab } from "./settings/settings_tab";
import { ICONS } from "./settings/ui/icons";

import { getEditorCommands } from "./features/editor_commands";
import { iterateCM6 } from "./utils/editor_utils";
import { reconfigureLatexSuiteConfig } from "./snippets/codemirror/config";
import { SnippetVariables, parseSnippetVariables, parseSnippets } from "./snippets/parse";
import { latexSuiteExtensions, optionalExtensions } from "./latex_suite";
import { sortSnippets } from "./snippets/sort";

export default class LatexSuitePlugin extends Plugin {
	settings: LatexSuitePluginSettings;
	CMSettings: LatexSuiteCMSettings;
	editorExtensions:Extension[] = [];

	async onload() {
		await this.loadSettings();

		this.loadIcons();
		this.addSettingTab(new LatexSuiteSettingTab(this.app, this));
		loadMathJax();

		this.legacyEditorWarning();

		// Register Latex Suite extensions and optional editor extensions for editor enhancements
		this.registerEditorExtension(this.editorExtensions);

		// Watch for changes to the snippet variables and snippets files
		this.watchFiles();

		this.addEditorCommands();
	}

	onunload() {

	}

	legacyEditorWarning() {
		// @ts-ignore
		if (this.app.vault.config?.legacyEditor) {
			const message = "Obsidian Latex Suite: This plugin does not support the legacy editor. Switch to Live Preview mode to use this plugin.";

			new Notice(message, 100000);
			console.log(message);

			return;
		}
	}

	async loadSettings() {
		let data = await this.loadData();

		// Migrate settings from v1.8.0 - v1.8.4
		const shouldMigrateSettings = data ? "basicSettings" in data : false;

		// @ts-ignore
		function migrateSettings(oldSettings) {
			return {
				...oldSettings.basicSettings,
				...oldSettings.rawSettings,
				snippets: oldSettings.snippets,
			};
		}

		if (shouldMigrateSettings) {
			data = migrateSettings(data);
		}

		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

		if (shouldMigrateSettings) {
			this.saveSettings();
		}

		if (this.settings.loadSnippetsFromFile || this.settings.loadSnippetVariablesFromFile) {
			const tempSnippetVariables = await this.getSettingsSnippetVariables();
			const tempSnippets = await this.getSettingsSnippets(tempSnippetVariables);

			this.CMSettings = processLatexSuiteSettings(sortSnippets(tempSnippets), this.settings);

			// Use onLayoutReady so that we don't try to read the snippets file too early
			this.app.workspace.onLayoutReady(() => {
				this.processSettings();
			});
		}
		else {
			await this.processSettings();
		}
	}

	async saveSettings(didFileLocationChange = false) {
		await this.saveData(this.settings);
		this.processSettings(didFileLocationChange);
	}

	async getSettingsSnippetVariables() {
		try {
			return await parseSnippetVariables(this.settings.snippetVariables);
		} catch (e) {
			new Notice(`Failed to load snippet variables from settings: ${e}`);
			console.log(`Failed to load snippet variables from settings: ${e}`);
			return {};
		}
	}

	async getSettingsSnippets(snippetVariables: SnippetVariables) {
		try {
			return await parseSnippets(this.settings.snippets, snippetVariables);
		} catch (e) {
			new Notice(`Failed to load snippets from settings: ${e}`);
			console.log(`Failed to load snippets from settings: ${e}`);
			return [];
		}
	}

	async getSnippets(becauseFileLocationUpdated: boolean, becauseFileUpdated: boolean) {
		// Get files in snippet/variable folders.
		// If either is set to be loaded from settings the set will just be empty.
		const files = getFileSets(this);

		const snippetVariables =
			this.settings.loadSnippetVariablesFromFile
				? await getVariablesFromFiles(this, files)
				: await this.getSettingsSnippetVariables();

		// This must be done in either case, because it also updates the set of snippet files
		const unknownFileVariables = await tryGetVariablesFromUnknownFiles(this, files);
		if (this.settings.loadSnippetVariablesFromFile) {
			// But we only use the values if the user wants them
			Object.assign(snippetVariables, unknownFileVariables);
		}

		const snippets =
			this.settings.loadSnippetsFromFile
				? await getSnippetsFromFiles(this, files, snippetVariables)
				: await this.getSettingsSnippets(snippetVariables);

		this.showSnippetsLoadedNotice(snippets.length, Object.keys(snippetVariables).length,  becauseFileLocationUpdated, becauseFileUpdated);

		return sortSnippets(snippets);
	}

	async processSettings(becauseFileLocationUpdated = false, becauseFileUpdated = false) {
		this.CMSettings = processLatexSuiteSettings(await this.getSnippets(becauseFileLocationUpdated, becauseFileUpdated), this.settings);
		this.reconfigureLatexSuiteConfig();
		this.refreshCMExtensions();
	}

	reconfigureLatexSuiteConfig() {
		iterateCM6(this.app.workspace, (view) => {
			view.dispatch({
				effects: reconfigureLatexSuiteConfig(this.CMSettings)
			});
		})
	}

	refreshCMExtensions() {
		// Remove all currently loaded CM extensions
		while (this.editorExtensions.length) this.editorExtensions.pop();

		// Load Latex Suite extensions
		this.editorExtensions.push(latexSuiteExtensions(this.CMSettings));

		// Load optional CM extensions according to plugin settings
		const extensionDict = optionalExtensions;
		const features = Object.keys(optionalExtensions);

		for (const feature of features) {
			// @ts-ignore
			if (this.CMSettings[feature + "Enabled"]) {
				this.editorExtensions.push(extensionDict[feature]);
			}
		}
		this.app.workspace.updateOptions();
	}

	showSnippetsLoadedNotice(nSnippets: number, nSnippetVariables: number, becauseFileLocationUpdated: boolean, becauseFileUpdated: boolean) {
		if (!(becauseFileLocationUpdated || becauseFileUpdated))
			return;

		const prefix = becauseFileLocationUpdated ? "Loaded " : "Successfully reloaded ";
		const body = [];

		if (this.settings.loadSnippetsFromFile)
			body.push(`${nSnippets} snippets`);
		if (this.settings.loadSnippetVariablesFromFile)
			body.push(`${nSnippetVariables} snippet variables`);

		const suffix = " from files.";
		new Notice(prefix + body.join(" and ") + suffix, 5000);
	}

	addEditorCommands() {
		for (const command of getEditorCommands(this)) {
			this.addCommand(command);
		}
	}

	watchFiles() {
		// Only begin watching files once the layout is ready
		// Otherwise, we'll be unnecessarily reacting to many onFileCreate events of snippet files
		// that occur when Obsidian first loads

		this.app.workspace.onLayoutReady(() => {

			const eventsAndCallbacks = {
				"modify": onFileChange,
				"delete": onFileDelete,
				"create": onFileCreate
			};

			for (const [key, value] of Object.entries(eventsAndCallbacks)) {
				// @ts-expect-error
				this.registerEvent(this.app.vault.on(key, (file) => value(this, file)));
			}
		});
	}

	loadIcons() {
		for (const [iconId, svgContent] of Object.entries(ICONS)) {
			addIcon(iconId, svgContent);
		}
	}
}
