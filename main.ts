import { App, Modal, normalizePath, Plugin, PluginSettingTab, Setting, TFile, TAbstractFile, TFolder, ButtonComponent, DropdownComponent } from "obsidian";
import { DiffMatchPatch } from "diff-match-patch-ts";
// @ts-ignore: Complains about default export this way, but since jszip 3.10 this
// is the recommended way
import JSZip from "jszip";


// Debuglevels in increasing severity so messages >= indexOf(debugLevel) will be
// shown
const debugLevels = ["debug", "info", "warn", "error"];

let logError = function(message?: any, ...optionalParams: any[]) {};
let logWarn = function(message?: any, ...optionalParams: any[]) {};
// Note console.log is an alias of console.info
let logInfo = function(message?: any, ...optionalParams: any[]) {};
let logDbg = function(message?: any, ...optionalParams: any[]) {};

function hookLogFunctions(debugLevelIndex: number, tag: string) {
    logInfo("hookLogFunctions", debugLevelIndex, tag);

    const logIgnore = function(message?: any, ...optionalParams: any[]) {};
    logError = (debugLevelIndex <= debugLevels.indexOf("error")) ? 
        console.error.bind(console, tag + "[ERROR]:") :
        logIgnore;
    logWarn = (debugLevelIndex <= debugLevels.indexOf("warn")) ?
        console.warn.bind(console, tag + "[WARN]:") :
        logIgnore;
    logInfo = (debugLevelIndex <= debugLevels.indexOf("info")) ?
        console.info.bind(console, tag + "[INFO]:") :
        logIgnore;
    logDbg = (debugLevelIndex <= debugLevels.indexOf("debug")) ?
        console.debug.bind(console, tag + "[DEBUG]:") :
        logIgnore;
}

function debugbreak() {
    debugger;
}


interface EditHistorySettings {
    minSecondsBetweenEdits: string;
    maxEdits: string;
    maxEditAge: string;
    maxHistoryFileSizeKB: string;
    editHistoryRootFolder: string;
    extensionWhitelist: string;
    showOnStatusBar: boolean;
    debugLevel: string;
    // XXX Have color setting for addition fore/back, deletion fore/back 
}

const DEFAULT_SETTINGS: EditHistorySettings = {
    minSecondsBetweenEdits: "60",
    maxEditAge: "0",
    maxEdits: "0",
    maxHistoryFileSizeKB: "0",
    editHistoryRootFolder: "",
    extensionWhitelist: ".md, .txt, .csv, .htm, .html",
    showOnStatusBar: true,
    debugLevel: "warn"
}

const EDIT_HISTORY_FILE_EXT = ".edtz";

// XXX Ignore changes if not enough diffs/too small?

// XXX Allow merging entries in the edit history file older than a given time,
//     at a given granularity

// XXX Feed the editor undo stack with the contents of the history file? (could
//     be done without private apis by inserting the text in edit history order at file
//     load, will probably need a flag to prevent from storing double history)

// XXX Have a timeline view of changes (per day, hour, etc)

// XXX Allow management in the edit history modal, merging diffs, deleting, deleting all history


export default class EditHistory extends Plugin {
    settings: EditHistorySettings;
    statusBarItemEl: HTMLElement;

    // Minimum number of milliseconds between edits, if a modification occurs
    // before that time will be ignored at this moment and lumped with later
    // modifications once the minimum time has passed and a new modification is done
    // This means that the edit file may not contain the latest version
    // Note that because of the current filename being derived from the epoch in
    // seconds, changes done less than one second apart are ignored and lumped with
    // the next change
    minMsBetweenEdits: number;
    // Maximum number of age in milliseconds or Infinity
    maxEditAgeMs: number;
    // Maximum number of edits to keep or Infinity
    maxEdits: number;
    // Maximum size in bytes of the history file or Infinity
    maxEditHistoryFileSize: number;
    // Whitelist of note filename extensions to store edit history for. In
    // lowercase and including the initial dot. Empty for all.
    extensionWhitelist: string[];
    // For now this should be "", other values work but the UX is not clear
    // because the folder will be visible and the user may move it around
    // breaking things
    editHistoryRootFolder: string;

    /**
     * @return true if an edit history file should be kept for this file
     */
    keepEditHistoryForFile(file: TAbstractFile): boolean {
        // Don't keep edit history for folders
        if (!(file instanceof TFile)) {
            return false;
        }

        // The vault will call on change callback on the edit history file when
        // modified using the Obsidian API, trap it so it's ignored downstream
        if (file.name.endsWith(EDIT_HISTORY_FILE_EXT)) {
            return false;
        }

        // Keep an edit history file for all files if there are no extensions,
        // otherwise just for the extensions that match
        if (this.extensionWhitelist.length == 0) {
            return true;
        } else {
            const filename = file.name.toLowerCase();
            for (let ext of this.extensionWhitelist) {
                if (filename.endsWith(ext)) {
                    return true;
                }
            }
        }
        return false;
    }

    keepEditHistoryForActiveFile(): boolean {
        const activeFile = this.app.workspace.getActiveFile();

        return ((activeFile != null) && (this.keepEditHistoryForFile(activeFile)));
    }
    
    getEditHistoryFilepath(filepath: string): string {
        return normalizePath(this.editHistoryRootFolder + "/" + filepath + EDIT_HISTORY_FILE_EXT);
    }
    
    getEditEpoch(editFilename: string): number {
        return parseInt(editFilename, 36) * 1000;
    }

    getEditIsDiff(editFilename: string): boolean {
        return editFilename.endsWith("$");
    }
    
    buildEditFilename(mtime: number, isDiff: boolean): string {
        const utcepoch = Math.floor(mtime / 1000);
        const editFilename = utcepoch.toString(36) + (isDiff ? "" : "$"); 
        return editFilename;
    }

    /**
     * Sort in place
     */
    sortEdits(filenames: string[], descending: boolean = true) {
        const i = descending ? 1 : -1; 

        filenames.sort((a,b) => i * (this.getEditEpoch(b) - this.getEditEpoch(a)));
    }

    parseSettings(settings: EditHistorySettings) {
        // Hook log functions as early as possible so any console output is seen
        // if enabled
        hookLogFunctions(debugLevels.indexOf(settings.debugLevel), "EditHistoryPlugin");

        this.minMsBetweenEdits = parseInt(settings.minSecondsBetweenEdits) * 1000 || Infinity; 
        this.maxEdits = parseInt(settings.maxEdits) || Infinity;
        this.maxEditAgeMs = parseInt(settings.maxEditAge) * 1000 || Infinity;
        let extensionWhitelist = settings.extensionWhitelist.split(",");
        for (let i in extensionWhitelist) {
            extensionWhitelist[i] = extensionWhitelist[i].trim().toLowerCase();
        }
        // XXX This needs to remove all edit history files when extensions are
        //     removed?
        this.extensionWhitelist = extensionWhitelist;
        this.maxEditHistoryFileSize = parseInt(settings.maxHistoryFileSizeKB) * 1024 || Infinity;
        // XXX Note this is currently not updated in the settings modal, so the
        //     value is unchanged
        this.editHistoryRootFolder = settings.editHistoryRootFolder;
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.parseSettings(this.settings);
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.parseSettings(this.settings);
    }

    async onload() {
        // Load settings as early as possible console output is seen if enabled
        await this.loadSettings();

        logInfo("onLoad");

        this.registerEvent(this.app.vault.on("modify", async (fileOrFolder: TAbstractFile, force: boolean = false) => {
            logInfo("vault modify", fileOrFolder.path);
            // This reports any files or folders modified via the api, ignore
            // non whitelisted files/folders
            if (!(this.keepEditHistoryForFile(fileOrFolder))) {
                logDbg("Ignoring non whitelisted file", fileOrFolder.path);
                return;
            }
            let file = fileOrFolder as TFile;
            let zipFilepath = this.getEditHistoryFilepath(file.path);
            let zipFile = this.app.vault.getAbstractFileByPath(zipFilepath);
            if ((zipFile != null) && !(zipFile instanceof TFile)) {
                // Not a file, error
                logError("Edit history file is not a file", zipFilepath);
                return;
            }

            // Ignore changes less than a given time ago unless forcing (ie event
            // was triggered explicitly in order to force saving pending edits)
            // XXX Abstract this and remove the force flag?
            if (!force && 
                (zipFile != null) && ((file.stat.mtime - zipFile.stat.mtime) < this.minMsBetweenEdits)) {
                logDbg("Need to pass", 
                    (this.minMsBetweenEdits - (file.stat.mtime - zipFile.stat.mtime)) / 1000, "s between edits, ignoring");
                return;
            }

            // Ideally, in order to minimize history file size, the history file
            // would store only diffs and then, at modify time:
            // 1. recreate the currently stored version applying the last stored
            //    diff to the pre-modified file
            // 2. compute the diff between the pre-modified file and the
            //    modified file
            // 3. store that diff 
            //
            // Unfortunately there's no way to get the pre-modified version here
            // since when the callback is called, the file has already been
            // modified, so only the modified version is available. The solution
            // is to always store the last modified version in full and then
            // when a new modification is done, replace that version with the
            // diff and store the full version, rinse repeat.
            //
            // Storing the latest version in full in the history file has
            // benefits, though:
            // - The history file can act as a backup even if the main file is
            //   deleted
            // - The history file is still valid even if the original file is
            //   modified from outside Obsidian
            
            // XXX Another option that would likely make the Edit History File
            //     smaller is to do the diffs backwards and store the first
            //     version fully and build diffs on top of that first version.
            //     That would make saving slower, though, since it will have to
            //     rebuild the history from the start on every save, or cache
            //     that the first time. Would also make trimming the history
            //     file slightly harder (needs to rebuild the version that will
            //     now become the first version when older versions are removed
            //     from the file).

            // Load the modified file data
            let fileData = await this.app.vault.read(file);
            let newFilename = this.buildEditFilename(file.stat.mtime, false);

            // Create or open the zip with the versions of this file
            let zip: JSZip = new JSZip();
            let zipData = (zipFile == null) ? null : await this.app.vault.readBinary(zipFile);
            let numEdits = 0;
            if (zipData != null) {
                // There's an existing zip file, update the most recent
                // edit in the zip from full to diff wrt the incoming
                // file
                await zip.loadAsync(zipData);
                
                // Read the latest edit which, if it exists, it should
                // be stored in full (vs diffed)
                
                // jszip seems to return newest files first, so arguably it
                // would be enough with getting the first file in the list,
                // but go through all of them and sort for robustness
                let filepaths:string[] = [];
                zip.forEach(function (relativePath:string, file: JSZip.JSZipObject) {
                    filepaths.push(relativePath);
                });

                // Sort most recent first
                this.sortEdits(filepaths);

                // Purge entries, oldest first
                let todayUTC = new Date().getTime();
                let zipFileSize = zipData.byteLength;
                while (filepaths.length > 0) {
                    let purge = false;
                    // Note entries are purged last entry first
                    let filepath = filepaths[filepaths.length-1];
                    // Note there's a new edit incoming, so check max number of
                    // edits for equality too
                    if (filepaths.length >= this.maxEdits) {
                        logInfo("Will purge entry", filepath, "over max count", 
                            filepaths.length, ">", this.maxEdits)
                        purge = true;
                    }
                    let filepathAgeMs = todayUTC - this.getEditEpoch(filepath);
                    if (filepathAgeMs > this.maxEditAgeMs) {
                        logInfo("Will purge entry", filepath, "over max age", 
                            filepathAgeMs * 1000, ">", this.maxEditAgeMs * 1000);
                        purge = true;
                    }
                    if (zipFileSize > this.maxEditHistoryFileSize) {
                        logInfo("Will purge entry", filepath, "over max size", 
                            zipFileSize, ">", this.maxEditHistoryFileSize);
                        // XXX Instead of just purging this could do something
                        //     smarter like merging entries which could also
                        //     decrease the history file size?
                        purge = true;
                        // The only way of getting the file size is by accessing
                        // the internal field _data
                        // See https://github.com/Stuk/jszip/issues/247
                        zipFileSize -= zip.file(filepath)._data.compressedSize;
                    }
                    if (!purge) {
                        // Entries are purged from the end, loop can exit if
                        // this entry is not purged
                        break;
                    }
                    logInfo("Purging entry", filepath);
                    filepaths.pop();
                    zip.remove(filepath);
                }
                numEdits = filepaths.length;
                
                if (filepaths.length > 0) {
                    // Diff the latest stored edit against the incoming file
                    // data, if the zip file is empty just store the incoming
                    // file. If there are no stored edits, continue to store the
                    // incoming one fully

                    // Note it needs to store the incoming file in full and not
                    // the diff because otherwise there's no way to reconstruct
                    // the previous version to diff against (Obsidian calls
                    // "modify" after the file has been written)

                    // XXX Will this ever be used for binary files? Don't do
                    //     diffs on binary files/extensions and always store
                    //     fully? Show some binary diff in the modal? image
                    //     diff?
                    
                    let mostRecentFilename = filepaths[0];
                    let mostRecentFile = zip.file(mostRecentFilename);

                    if (this.getEditEpoch(mostRecentFilename) == this.getEditEpoch(newFilename)) {
                        // Don't allow changes done at the same epoch since it
                        // will get the same filename and overwrite the previous
                        // version, corrupting the history. With the current
                        // epoch granularity this essentially means that changes
                        // have to be at least one second apart, which is almost
                        // always the case unless there's a forced save.
                        // XXX This could just remove the last change and update
                        //     to this one?
                        logInfo("Delaying entry due to colliding epochs");
                        return;
                    }
                    
                    let dmpobj = new DiffMatchPatch();
                    logInfo("unpacking " + mostRecentFilename);
                    let prevFileData = await mostRecentFile.async("string");
                    // @ts-ignore: complains about missing opt_c, but
                    // passing only two arguments is actually allowed by the
                    // diff-match-patch API
                    let diffs = dmpobj.patch_make(fileData, prevFileData.toString());
                    if (diffs.length > 0) {
                        let patch = dmpobj.patch_toText(diffs);

                        // XXX Don't save the version if it has less than a
                        //     given size in bytes? (but it has already done the
                        //     work and the savings because of merging updates
                        //     may not be that big, although at the very least
                        //     it shouldn't save versions where most of it are
                        //     control chars?)
                        
                        // Don't bother replacing with the diffed version if
                        // the diff is larger than the original
                        if (patch.length < prevFileData.length) {
                            // Replace the previous version with a diff wrt the
                            // newest version
                            logInfo("Removing ", mostRecentFilename);
                            zip.remove(mostRecentFilename);
                            // Store as a diff
                            mostRecentFilename = this.buildEditFilename(
                                this.getEditEpoch(mostRecentFilename), 
                                true
                            );
                            logInfo("Storing ", mostRecentFilename, " with date ", 
                                mostRecentFile.date, " timestamp ", mostRecentFile.extendedTimestamp);
                            // XXX Investigate why there's no need to undo
                            //     the UTC offset here: 
                            //     - Javascript UTC dates are stored as is
                            //       in the zip object metadata
                            //     - To prevent bad dates 
                            //
                            await zip.file(mostRecentFilename, patch,
                                { date: mostRecentFile.date, compression:"DEFLATE" });
                        }
                    } else {
                        logInfo("No changes detected, ignoring");
                        return;
                    }
                }  
            }

            // Store the newest version in full

            // jszip stores dates in UTC but the zip standard and zip tools
            // expect the date in local times (DOS times). Also, note that
            // dates in zip are only accurate to even seconds because DOS
            // times only use 16 bytes, which can only fit 5 bits for
            // seconds.

            // If we want tools (explorer, total commander...) to display
            // the right date, we could store the local date by providing
            // jszip with the UTC offset undone:
            //     dateWithOffset = new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000);
            // But it has limited use since those tools won't show the right
            // date across timezones or DST changes, eg a file in a zip
            // saved before DST with time 10.30 will be displayed with time
            // 9.30 after DST. 

            // see https://github.com/Stuk/jszip/issues/369
            // see https://github.com/Stuk/jszip/blob/master/lib/reader/DataReader.js#L113
            // see https://opensource.apple.com/source/zip/zip-6/unzip/unzip/proginfo/extra.fld
            // see https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
            let dateWithOffset = new Date(file.stat.mtime - new Date().getTimezoneOffset() * 60000);
            logInfo("Storing", newFilename, " with date", dateWithOffset);
            zip.file(newFilename, fileData, { date: dateWithOffset, compression:"DEFLATE" });
            
            // Generate zip archive and save
            let newZipData = await zip.generateAsync({type: "arraybuffer", compression: "DEFLATE"});
            if (zipFile == null) {
                // No existing zip file, create
                
                // The directory may not exist if history files are not saved
                // alongside notes, and createBinary won't create the directory,
                // so create it here. Do it unconditionally for simplicity and
                // ignore errors, let createBinary fail if there was a problem
                
                // XXX Obsidian has issues with directories starting with "." :
                //     - createBinary succeeds in creating the binary in a
                //       directory starting with "." but returns null instead of a TFile
                //     - createFolder succeeds in creating a folder starting with "."
                //     - getAbstractFileByPath of a path starting with "." returns null
                let dirpath = zipFilepath.substring(0, zipFilepath.lastIndexOf("/")+1);
                logInfo("Conservatively creating dir", dirpath);
                await this.app.vault.createFolder(dirpath).catch(()=>null);
                let zipFile = await this.app.vault.createBinary(zipFilepath, newZipData);
                if (zipFile == null) {
                    logError("Can't create edit history file", zipFilepath);
                    return;
                }
            } else {
                // Update the zip file
                await this.app.vault.modifyBinary(zipFile, newZipData);
            }
            // XXX This needs to update when switching panes, etc, or set a timer
            this.statusBarItemEl.setText((numEdits + 1) + " edits");
        }));
        
        this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
            logInfo("vault rename path", file.path);
            // This reports any files or folders modified via the api, ignore
            // non whitelisted files/folders
            // Note if a folder is renamed each children will get a call here
            // with the new path
            if ((file instanceof TFolder) && (file.path == this.editHistoryRootFolder)) {
                // The history file root folder is being renamed, update in the
                // settings
                
                // XXX This may not work depending on the renaming of the
                //     history root folder and history files vs. original notes?
                //     But note the history edit file folder is set to "" for
                //     the time being, so this code won't run and this is not an
                //     issue yet
                logInfo("Renaming history folder, updating settings from", 
                    this.settings.editHistoryRootFolder, "to", file.path);
                this.settings.editHistoryRootFolder = file.path;
                this.saveSettings();
            } 

            if (!(this.keepEditHistoryForFile(file))) {
                logDbg("Ignoring non whitelisted file", file.path);
                return;
            }

            // Don't move edit history files when the note is moved if notes and
            // edit history files are in the same directory (ie empty
            // editHistoryRootFolder). Otherwise, moving the edit history file
            // would cause Obsidian to throw a benign error when it tries to
            // move the edit history file and finds it's not there anymore.
            if ((this.settings.editHistoryRootFolder == "") && 
                (oldPath.split("/").pop() == file.name)) {
                logDbg("Ignoring directory-only change rename");
                return;
            }

            // Rename the edit history file if any

            let zipFilepath = this.getEditHistoryFilepath(oldPath);
            let zipFile = this.app.vault.getAbstractFileByPath(zipFilepath);
            if (zipFile != null) {
                let newZipFilepath = this.getEditHistoryFilepath(file.path);
                logInfo("Renaming edit history file", zipFilepath,"to", newZipFilepath);
                this.app.vault.rename(zipFile, newZipFilepath);
            }
        }));

        this.registerEvent(this.app.vault.on("delete", (file: TAbstractFile) => {
            logInfo("vault delete path", file.path);
            // This reports any files or folders modified via the api, ignore
            // non whitelisted files/folders
            if (!(this.keepEditHistoryForFile(file))) {
                logDbg("Ignoring non whitelisted file", file.path);
                return;
            }
            // Delete the edit history file if any
            let zipFilepath = this.getEditHistoryFilepath(file.path);
            let zipFile = this.app.vault.getAbstractFileByPath(zipFilepath);
            if (zipFile != null) {
                logInfo("Deleting edit history file", zipFilepath);
                // XXX Should this trash instead of delete? (the Obsidian
                //     setting under Files and Links allows choosing between
                //     system trash, obsidian trash and delete)
                this.app.vault.delete(zipFile);
            }
        }));

        // XXX Use notices for some information/error messages

        // The ribbon can be disabled from Obsidian UI, no need to check for a
        // specific disable here
        const ribbonIconEl = this.addRibbonIcon("clock", "Open edit history", (evt: MouseEvent) => {
            if (this.keepEditHistoryForActiveFile()) {
                new EditHistoryModal(this).open();
            }
        });

        const statusBarItemEl = this.addStatusBarItem();
        statusBarItemEl.setText("? edits");
        // Add the highlight on hover of other status bar items
        statusBarItemEl.addClass("mod-clickable");
        this.statusBarItemEl = statusBarItemEl;
        const plugin = this;
        statusBarItemEl.onclick = function () {
            if (plugin.keepEditHistoryForActiveFile()) {
                new EditHistoryModal(plugin).open();
            }
        }; 
        
        this.statusBarItemEl.toggle(this.settings.showOnStatusBar);
        
        this.addCommand({
            id: "open-edit-history",
            name: "Open edit history for this file",
            checkCallback: (checking: boolean) => {
                if (this.keepEditHistoryForActiveFile()) {
                    if (!checking) {
                        new EditHistoryModal(this).open();
                    }
                    return true;
                } 
                return false;
            }
        });

        this.addCommand({
            id: "save-edit-history",
            name: "Save current edit in the edit history",
            checkCallback: (checking: boolean) => {
                if (this.keepEditHistoryForActiveFile()) {
                    if (!checking) {
                        logInfo("Forcing storing edit");
                        this.app.vault.trigger("modify", this.app.workspace.getActiveFile(), true);
                    }
                    return true;
                } 
                return false;
            }
        });


        this.addSettingTab(new EditHistorySettingTab(this.app, this));
    }

    onunload() {
        logInfo("unload");
    }
}

class EditHistoryModal extends Modal { 
    plugin: EditHistory;
    currentVersionData: string;
    diffInfo: HTMLElement;

    constructor(plugin: EditHistory) { 
        super(plugin.app);
        this.plugin = plugin;
    }

    async onOpen() {
        const {contentEl} = this;

        let file = this.app.workspace.getActiveFile();
        if ((file == null) || (!this.plugin.keepEditHistoryForFile(file))) {
            // XXX This should never happen since callers don't fire the modal?
            logWarn("Edit history not allowed for active file");
            return;
        }

        // Note this may differ from the last edit stored in the zip since not
        // all edits are stored in the file depending on the value of
        // this.minMsBetweenEdits
        let latestData = await this.app.vault.read(file);

        contentEl.addClass("edit-history-modal");
        
        this.titleEl.setText("Edits for ");
        this.titleEl.createEl("i", { text: file.name });

        // Create or open the zip with the edit history of this file

        // XXX Review perf notes at https://stuk.github.io/jszip/documentation/limitations.html
        let zip: JSZip = new JSZip();
        let zipFilepath = this.plugin.getEditHistoryFilepath(file.path);
        logInfo("Opening zip file ", zipFilepath);
        let zipFile = this.app.vault.getAbstractFileByPath(zipFilepath);
        if ((zipFile == null) || (!(zipFile instanceof TFile))) {
            logWarn("No history file or not a file", zipFilepath);
            contentEl.createEl("p", { text: "No edit history"});
            return;
        }

        let zipData = await this.app.vault.readBinary(zipFile);
        if (zipData == null) {
            logWarn("Unable to read history file");
            contentEl.createEl("p", { text: "No edit history"});
            return;
        }

        await zip.loadAsync(zipData);

        let filepaths:string[] = [];
        zip.forEach(function (relativePath:string) {
            filepaths.push(relativePath);
        });
        if (filepaths.length == 0) {
            logWarn("Empty edit history file");
            contentEl.createEl("p", { text: "No edit history"});
            return;
        }

        let revStats = contentEl.createEl("p");
        const control = contentEl.createDiv("setting-item-control")
        control.style.justifyContent = "flex-start";
        const select = new DropdownComponent(control);
        select.selectEl.focus();
        const diffInfo = control.createEl("span");
        this.diffInfo = diffInfo;
        
        // XXX Add prev and next diff buttons/hotkeys
        new ButtonComponent(control)
            .setButtonText("Copy")
            .setClass("mod-cta")
            .onClick(() => {
                logInfo("Copied to clipboard");
                navigator.clipboard.writeText(this.currentVersionData);
        });

        contentEl.createEl("br");
        contentEl.createEl("br");
        
        let diffDiv = contentEl.createDiv("diff-div");
        select.onChange( async () => {
            // This is called both implicitly but also explicitly with a dummy
            // event that cannot fill the necessary fields, don't access the
            // event data and access the current select state instead 
            // XXX Abstract out instead?
            let selectedEdit = select.getValue();

            // Rebuild the file data of the given edit by applying the patches
            // in reverse, if one of the edits is stored fully, discard the
            // accumulated patched data and use the full data
            let dmpobj = new DiffMatchPatch();
            let data = latestData;
            let previousData = latestData;

            for (let filepath of filepaths) {
                let diff = await zip.file(filepath).async("string");

                previousData = data;

                if (this.plugin.getEditIsDiff(filepath)) {
                    // The full file was stored, there's no diff
                    data = diff;
                } else {
                    // Rebuild the data from the diff applied to the current
                    // data
                    let patch = dmpobj.patch_fromText(diff);
                    // XXX This could collect patches and apply them in a
                    //     single call after the loop
                    data = dmpobj.patch_apply(patch, data)[0];
                }

                if (selectedEdit == filepath) {
                    break
                }
            }
            // Display the diff against the latest edit
            // XXX Have an option to diff against arbitrary edits?
            // XXX This redoes the diff which shouldn't be necessary since
            //     we have all the patches, but it's not clear how to
            //     convert from patch to diff, looks like patch.diff is the
            //     set of diffs for a given patch? (but will still need to 
            //     re-diff when the whole file is saved instead of the diff)
            this.currentVersionData = data;
            let diffs = dmpobj.diff_main(data, previousData);
            // XXX Number of diffs is not a great measurement, this could show
            //     chars added/chars deleted
            this.diffInfo.setText(diffs.length + " diff" + ((diffs.length != 1) ? "s" : ""));
            // XXX Generating the HTML manually is pretty simple, roll our
            //     own code instead of using diff_prettyHtml and having to
            //     search/replace the styles and spaces below. See
            //     https://github.com/google/diff-match-patch/blob/master/javascript/diff_match_patch_uncompressed.js
            let diffHtml = dmpobj.diff_prettyHtml(diffs);
            // Remove the styles used by prettyHtml
            // <ins style="background:#e6ffe6;">
            diffHtml = diffHtml.replace(/<ins [^>]*>/g, "<ins>");
            // <del style="background:#ffe6e6;">
            diffHtml = diffHtml.replace(/<del [^>]*>/g, "<del>");
            // XXX Make colors configurable, in modal setting or per theme
            //     light/dark
            //     See https://github.com/friebetill/obsidian-file-diff/issues/1#issuecomment-1425157959
            // XXX Have prev/next diff occurrence navigation
            // XXX Have a button to roll back to version
            // XXX Have an option to remove end of paragraph chars
            // XXX innerHTML is discouraged for security reasons, change?
            //     (note this is safe because it comes from diff_prettyHtml)
            //     See https://github.com/obsidianmd/obsidian-releases/blob/master/plugin-review.md#avoid-innerhtml-outerhtml-and-insertadjacenthtml
            diffDiv.innerHTML = diffHtml;
            // Diffs are spans of <ins> os <del> tags, scroll to the first one
            diffDiv.querySelector<HTMLElement>("ins,del")?.scrollIntoView();
        });

        // Sort most recent first (sorting is probably overkill since the zip
        // seems to list in creation order already)
        this.plugin.sortEdits(filepaths);
        // Create option entries
        for (let filepath of filepaths) {
            const utcepoch = this.plugin.getEditEpoch(filepath);
            const date = new Date(utcepoch);
            select.addOption(filepath, date.toLocaleString());
        }
        // Force initialization done inside onChange
        select.selectEl.trigger("change");
        
        // Fill in the stats now that all the information is available
        // XXX Use human friendly units
        revStats.setText( filepaths.length + " edit" + 
            ((filepaths.length > 1) ? "s, " : ", ") + zipFile.stat.size + " bytes compressed, " + 
            this.app.workspace.getActiveFile()?.stat.size + " note bytes");

        // XXX This shouldn't be here, but this is the best until it's done when
        //     switching panes, etc (or use a timer?)
        this.plugin.statusBarItemEl.setText(filepaths.length + " edits");
    }

    onClose() {
        logInfo("onClose");
        const {contentEl} = this;
        contentEl.empty();
    }
}

class EditHistorySettingTab extends PluginSettingTab { plugin:
    EditHistory;

    constructor(app: App, plugin: EditHistory) {
        super(app, plugin);
        this.plugin = plugin;
    }
    hide(): any {
        logInfo("hide");
        super.hide();
    }
    display(): void {
        const {containerEl} = this;

        containerEl.empty();

        let author = containerEl.createEl("small", { text: "Created by "});
        let link = containerEl.createEl("a", { text: "Antonio Tejada", href:"https://github.com/antoniotejada/"});
        author.appendChild(link);

        // h2 is abnormally small in settings, start with h3 which has the right
        // size (other plugins do the same)
        containerEl.createEl("h3", {text: "General"});

        new Setting(containerEl)
            .setName("Minimum seconds between edits")
            .setDesc("Minimum number of seconds that must pass from the previous edit to store a new edit. Modifications done between those seconds will be merged into the next edit, reducing the edit history file size at the expense of less history granularity.")
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.minSecondsBetweenEdits)
                .setValue(this.plugin.settings.minSecondsBetweenEdits)
                .onChange(async (value) => {
                    logInfo("Minimum seconds between edits: " + value);
                    this.plugin.settings.minSecondsBetweenEdits = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
                .setName("Maximum number of edits")
                .setDesc("Maximum number of edits to keep, set to 0 for no limit. Older edits will be deleted from the history in the next update, reducing the edit history file size at the expense of less history.")
                .addText(text => text
                    .setPlaceholder(DEFAULT_SETTINGS.maxEdits)
                    .setValue(this.plugin.settings.maxEdits)
                    .onChange(async (value) => {
                        logInfo("Maximum number of edits: " + value);
                        this.plugin.settings.maxEdits = value;
                        await this.plugin.saveSettings();
                    }));

        new Setting(containerEl)
            .setName("Maximum age of edits")
            .setDesc("Oldest edit to keep in seconds, eg set to 3600 to delete edits that are more than one hour old, set to 0 for no limit. Older edits will be deleted from the history in the next update, reducing the edit history file size at the expense of less history.")
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.maxEditAge)
                .setValue(this.plugin.settings.maxEditAge)
                .onChange(async (value) => {
                    logInfo("Maximum age of edits: " + value);
                    this.plugin.settings.maxEditAge = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Maximum size of the history file (KB)")
            .setDesc("Maximum size of the history file in kilobytes, set to 0 for no limit. When over the size, edits will be deleted from the history in the next update, older edits first, reducing the edit history file size at the expense of less history.")
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.maxHistoryFileSizeKB)
                .setValue(this.plugin.settings.maxHistoryFileSizeKB)
                .onChange(async (value) => {
                    logInfo("Maximum history file size: " + value);
                    this.plugin.settings.maxHistoryFileSizeKB = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("File extension whitelist")
            .setDesc("List of file extensions to store edits for. Empty to store edits for all files.\nNote if an extension is removed, old edit history files will need to be removed manually.")
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.extensionWhitelist)
                .setValue(this.plugin.settings.extensionWhitelist)
                .onChange(async (value) => {
                    logInfo("File extension whitelist: " + value);
                    this.plugin.settings.extensionWhitelist = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl("h3", {text: "Appearance"});
        new Setting(containerEl)
            .setName("Show on status bar")
            .setDesc("Show edit history file information on the status bar. Click the status bar to show the edit history for the current file.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showOnStatusBar)
                .onChange(async (value) => {
                    logInfo("Show edits on status bar: " + value);
                    this.plugin.settings.showOnStatusBar = value;
                    await this.plugin.saveSettings();
                    this.plugin.statusBarItemEl.toggle(this.plugin.settings.showOnStatusBar);
            }));

        containerEl.createEl("h3", {text: "Debugging"});
        new Setting(containerEl)
            .setName("Debug level")
            .setDesc("Messages to show in the javascript console.")
            .addDropdown(dropdown => dropdown
                .addOption("error", "Errors")
                .addOption("warn", "Warnings")
                .addOption("info", "Information")
                .addOption("debug", "Verbose")
                .setValue(this.plugin.settings.debugLevel)
                .onChange(async (value) => {
                    logInfo("Debug level: " + value);
                    this.plugin.settings.debugLevel = value;
                    await this.plugin.saveSettings();
                }));


        /* XXX Issues with allowing a user-configured history folder: 
            - any history folder will mimic the the structure of the note
              directory (alternatively history files could be on a flat
              directory with the name coming from a hash of the full path, but
              that makes renaming more involved, and fishing for history files
              less intuitive)

            - due to an Obsidian design decision, folders cannot start with "."
              so the user-defined history folder be visible in the file explorer
                - Note this limitation is not consistently enforced through the
                    API:
                    - Obsidian does allow createBinary on a path starting with a
                      dot and it successfully creates the file
                    - Unfortunately getAbstractFileFromPath on a path starting
                      with a dot fails so the file can be created (which only
                      requires the path) but not modified (which requires a
                      TAbstractFile)

            - because it's visible, the user can rename the edit history folder
              from the obsidian UI,
                - renaming the topmost directory could be supported since the
                  only thing needed would be to update the internal variable.
                  Obisidan API notifies of the top level rename and each
                  children, which can be ignored. This will need care depending
                  on the reporting order of root vs. children and the update of
                  the internal variable.
                - if the user renames a non-top level directory then all
                  children history files would go out of sync, so this is a
                  problem.

            - the Obsidian setting onChange gets called on every keystroke, so
               configuring the edit history folder in settings would cause a
               rename on each keystroke. There doesn't seem to be a final
               changed(), hide() is not called either
            
            - it's not clear whether the folder should be deleted if empty
            
            - it's not clear if it's safe to just copy all the files found with
              whatever extension new Setting(containerEl) .setName('Edits
              folder') .setDesc('Folder to store the edit history file. Empty to
              store the edit file in the same directory alongside the original
              file. Due to Obsidian limitations this must start with a character
              other than "."') .addText(text => text .setPlaceholder('Enter the
              folder name')
              .setValue(this.plugin.settings.editHistoryRootFolder)
              .onChange(async (value) => { logInfo("onChange");
              logInfo('Edits folder: ' + value); // Only allow top level
              folders

                    this.plugin.settings.editHistoryRootFolder = value;


            // XXX Can the folder just be renamed via the file explorer
            interface? // XXX Check no dir component starts with "." // XXX
            Delete edits? copy them to new folder? trash them? // XXX Ask the
            user to delete folder? // XXX Ask for confirmation? // XXX Use
            private apis to store in some hidden folder? await
            this.plugin.saveSettings();
                }));
        */


}
}
