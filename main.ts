import { 
    App, 
    ButtonComponent, 
    DropdownComponent,
    Modal, 
    normalizePath, 
    Notice,
    Plugin, 
    PluginSettingTab, 
    setIcon,
    Setting, 
    TAbstractFile, 
    TFile, 
    TFolder, 
    ToggleComponent
} from "obsidian";
import { DiffMatchPatch, Diff } from "diff-match-patch-ts";
// diff-match-patch-ts doesn't export properly module enums, it uses a const
// enum (instead of a non const enum) which is removed at compile time and not
// visible by importers:
//  - Without isolatedModules set it errors out with "Cannot access ambient
//    const enums when the '--isolatedModules' flag is provided" 
//  - With isolated isolatedModules set to false in tsconfig.json, when
//    importing DiffOp the DiffOp object exists but it's null and the defines
//    cannot be used 
// Copy them here from diff-op.enum.d.ts
const enum DiffOp {
    Delete = -1,
    Equal = 0,
    Insert = 1
}

// @ts-ignore: Complains about default export this way, but since jszip 3.10
// this is the recommended way
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

 const htmlChars :  { [key: string]: string } = {
    "&" : "&amp;",
    "\"": "&quot;",
    "'/": '&#39;',
    "<" : '&lt;',
    ">": '&gt;',
    "\n": "<br>\n",
 };
 const htmlCharsRegexp = new RegExp(Object.keys(htmlChars).join("|"), "g");

 const htmlWhitespaceChars : { [key: string]: string } = {
     ...htmlChars,
    "\t": "&rarr;\t",
    " ": "&middot;",
    "\n": "&para;<br>\n"
 };
 const htmlWhitespaceCharsRegexp = new RegExp(Object.keys(htmlWhitespaceChars).join("|"), "g");

function htmlEncode(str: string, whitespace: boolean): string {
    // XXX or use document.createTextNode(str).textContent?
    // This can be a performance hotspot, so use an efficient way of replacing
    // multiple strings in a single pass
    return (whitespace) 
        ? str.replace(htmlWhitespaceCharsRegexp, c => htmlWhitespaceChars[c])
        : str.replace(htmlCharsRegexp, c => htmlChars[c]);
}

enum DiffDisplayFormat {
    Raw        = "RAW",
    Timeline   = "TIMELINE",
    Inline     = "INLINE",
    Horizontal = "HORIZONTAL",
    Vertical   = "VERTICAL",
};

const diffDisplayFormatToString: Record<DiffDisplayFormat, string> = {
    [DiffDisplayFormat.Raw]        : "raw",
    [DiffDisplayFormat.Timeline]   : "timeline",
    [DiffDisplayFormat.Inline]     : "inline",
    [DiffDisplayFormat.Horizontal] : "side by side",
    [DiffDisplayFormat.Vertical]   : "top by bottom",
};

interface EditHistorySettings {
    minSecondsBetweenEdits: string;
    maxEdits: string;
    maxEditAge: string;
    maxHistoryFileSizeKB: string;
    editHistoryRootFolder: string;
    extensionWhitelist: string;
    substringBlacklist: string;
    showOnStatusBar: boolean;
    diffDisplayFormat: string;
    showWhitespace: boolean;
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
    substringBlacklist: "",
    showOnStatusBar: true,
    diffDisplayFormat: DiffDisplayFormat.Inline,
    showWhitespace: true,
    debugLevel: "warn"
}

const EDIT_HISTORY_FILE_EXT = ".edtz";

// XXX Use Github actions to release plugin 
//     See https://docs.obsidian.md/Plugins/Releasing/Release+your+plugin+with+GitHub+Actions
//     See https://github.com/marcusolsson/obsidian-projects/blob/main/.github/workflows/release.yml

// XXX Ignore changes if not enough diffs/too small?

// XXX Allow merging entries in the edit history file older than a given time,
//     at a given granularity

// XXX Feed the editor undo stack with the contents of the history file? (could
//     be done without private apis by inserting the text in edit history order at file
//     load, will probably need a flag to prevent from storing double history)

// XXX Allow management in the edit history modal, merging diffs, deleting, deleting all historyç

// XXX tgz reduces size by half, use native browser gzip plus tar? (at the
//     expense of having to uncompress the whole file in memory, not clear jszip
//     does that already anyway?)
//     See https://stackoverflow.com/questions/65446607/how-do-i-extract-data-from-a-tar-gz-file-stored-in-the-cloud-from-a-browser


export default class EditHistory extends Plugin {
    settings: EditHistorySettings;
    statusBarItemEl: HTMLElement;

    // Minimum number of milliseconds between edits or Infinity, if a
    // modification occurs before that time will be ignored at this moment and
    // lumped with later modifications once the minimum time has passed and a
    // new modification is done This means that the edit file may not contain
    // the latest version Note that because of the current filename being
    // derived from the epoch in seconds, changes done less than one second
    // apart are ignored and lumped with the next change 
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
    // Blacklist of note filepath substrings not to store edit history for. In
    // lowercase, empty for none. Note obsidian normalizes paths to use forward
    // slash, so substrings for paths should use forward slashes
    substringBlacklist: string[];
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

        // Don't keep edit history file for filepaths containing the substring
        // blacklist
        if (this.substringBlacklist.length > 0) {
            const filepath = file.path.toLowerCase();
            for (let substring of this.substringBlacklist) {
                if (filepath.contains(substring)) {
                    logInfo("Not keeping history file '" + filepath + "' due to blacklist substring '" + substring + "'");
                    return false;
                }
            }
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

    getEditCompressedSize(zip: JSZip, filepath: string): number {
        // The only way of getting the file size is by accessing
        // the internal field _data
        // See https://github.com/Stuk/jszip/issues/247
        return zip.file(filepath)._data.compressedSize;
    }
    
    getEditEpoch(editFilename: string): number {
        return parseInt(editFilename, 36) * 1000;
    }

    getEditDate(editFilename: string): Date {
        return new Date(this.getEditEpoch(editFilename));
    }

    getEditLocalDateStr(editFilename: string): string {
        return this.getEditDate(editFilename).toLocaleString();
    }

    getEditFileTime(editFilename: string): number {
        // Note this ignores the hh:mm:ss part of the time
        let d = this.getEditDate(editFilename);
        d = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const t = d.getTime();
        return t;
    }

    getEditIsDiff(editFilename: string): boolean {
        return !editFilename.endsWith("$");
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
        // Note this cannot do straight alphabetical sort on the base-36 encoded
        // epochs since theoretically strings could be different lengths, convert
        // to epoch before sorting
        // XXX Could do .length plus < checks, though, removing trailing $ when
        //     necessary)
        filenames.sort((a,b) => i * (this.getEditEpoch(b) - this.getEditEpoch(a)));
    }

    commaSeparatedToList(s: string) {
        let list : string[] = [];
        // typescript string.split() returns 1-element array with empty item if
        // s is empty, return empty list instead. Note if s is whitespace still
        // want to return a single element list with a whitespace item.
        if (s != "") {
            list = s.split(",");
            for (let i in list) {
                list[i] = list[i].trim().toLowerCase();
            }
        }
        
        return list;
    }

    parseSettings(settings: EditHistorySettings) {
        // Hook log functions as early as possible so any console output is seen
        // if enabled
        hookLogFunctions(debugLevels.indexOf(settings.debugLevel), "EditHistoryPlugin");

        this.minMsBetweenEdits = parseInt(settings.minSecondsBetweenEdits) * 1000 || Infinity; 
        this.maxEdits = parseInt(settings.maxEdits) || Infinity;
        this.maxEditAgeMs = parseInt(settings.maxEditAge) * 1000 || Infinity;
        // XXX This needs to remove all edit history files when
        //     extensions/substrings are removed/added?
        this.extensionWhitelist = this.commaSeparatedToList(settings.extensionWhitelist)
        this.substringBlacklist = this.commaSeparatedToList(settings.substringBlacklist);
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

        // XXX Make this a member variable?
        let dmpobj = new DiffMatchPatch();

        logInfo("onLoad");

        this.registerEvent(this.app.vault.on("modify", async (fileOrFolder: TAbstractFile, force: boolean = false) => {
            logInfo("vault modify", fileOrFolder.path);
            // This reports any files or folders modified via the api, ignore
            // non whitelisted files/folders
            if (!(this.keepEditHistoryForFile(fileOrFolder))) {
                logDbg("Ignoring non whitelisted file", fileOrFolder.path);
                return;
            }

            if ((this.minMsBetweenEdits == Infinity) && !force) {
                // Don't generate a history file when manual saving is on until
                // it's done manually. This prevents generating empty history
                // files below for files that may never be manually saved
                logDbg("Ignoring due to manual saving enabled")
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
            
            // XXX Cleanup all naming:
            //
            //     - revision/edit: each individual file stored inside the zip
            //       file containg a dmp patch in text form (collection of
            //       contextless dmp diffs). Has a unique date and time. The
            //       file stores the diff between this version and the previous
            //       one and has the date at which the current version was
            //       saved. First the whole version is saved verbatim without
            //       diffs, when the next version comes across, then the current
            //       version is diffed against the verbatim version and the
            //       verbatin replaced with that diff
            //
            //     - diff: a version has one or more diffs (or none if the file
            //       was stored verbatim).
            //
            //     - dmp diff: A dmp diff is context-full, it can be traversed.
            //       Each diff has one DiffOp operation (delete, equal, insert)
            //       with one or more lines of payload
            //
            //     - dmp patch: A dmp a patch is context-less, ie a set of diffs
            //       that requires the file in order to be applied. Only has
            //       delete and insert operations, equal has been removed so
            //       they cannot be applied without the original file

            // Ignore changes less than a given time ago unless forcing (ie event
            // was triggered explicitly in order to force saving pending edits)
            // XXX Abstract this and remove the force flag?
            
            // Note this uses the zipFile time and not the entry time (which
            // requires reading the zipFile and has a DOS date 2-second
            // inaccuracy and is local time) or the name to timestamp
            // translation (which is accurate and UTC but requires hitting the
            // zipFile)
            
            // XXX The zipFile date could be cached for later invocations to
            //     early exit above without even decoding the zipfile path? (but
            //     requires a per zipFile cache)
            
            // XXX Still there can be some minor inaccuracy because the zipFile
            //     date is not reset, see
            //     https://github.com/antoniotejada/obsidian-edit-history/issues/15

            // XXX This has the issue that edits that are far apart in time 
            //      could appear merged together:
            //      1) An edit A was done at time T but it was too close to
            //         the previous edit so it's ignored
            //      2) Edit B is done hours later, now edit A and B are
            //         stored as a single edit
            //     This should either 
            //     a) merge the current edit with the previous one as long
            //        as not enough time has passed (inefficient since it will
            //        be doing idle work on every modification) 
            //     b) fire a timer on every modification, and only save from
            //        that timer. Probably delay that timer if already running
            //        so edits are only saved after "n seconds of idle time"
            //        Using a timer also avoids any date checks on the file
            //        This needs to watch out for any race conditions with a
            //        simultaneous change, hopefully none since the file api
            //        should be safe? (and typescript should be single
            //        threaded) but still the file could have been deleted in 
            //        the interim? Note this approach will still merge
            //        unrelated edits when the app is closed before the timer
            //        expires. The timer needs to be per file/editor?
            //     See https://github.com/antoniotejada/obsidian-edit-history/issues/9
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
                        zipFileSize -= this.getEditCompressedSize(zip, filepath);
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


            // Since Obsidian will move the folder contents when a folder is
            // moved, only move the history file when the note is renamed or
            // moved to a different parent (or if history files are kept in
            // their own directory)
            // Otherwise, moving the edit history file would cause Obsidian to
            // throw a benign error when it tries to move the edit history file
            // and finds it's not there anymore.
            const oldFiledirs = oldPath.split("/");
            const oldFilename = oldFiledirs.pop();
            const oldParentFolder = (oldFiledirs.length > 0) ? oldFiledirs.pop() : "";
            const filedirs = file.path.split("/");
            const filename = filedirs.pop();
            const parentFolder = (filedirs.length > 0) ? filedirs.pop() : "";
            if ((this.settings.editHistoryRootFolder == "") && 
                ((oldParentFolder == parentFolder) && (oldFilename == filename))) {
                logDbg("Not moving edit history, expected to be moved later alongside parent folder");
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
    curDiffIndex: number;
    diffElements: NodeListOf<HTMLElement>;
    
    constructor(plugin: EditHistory) { 
        super(plugin.app);
        this.plugin = plugin;
    }

    renderCalendar(calendarDiv: HTMLElement, select: DropdownComponent, zipFile: TFile, zip: JSZip, filepaths: string[]) {
        // XXX Abstract this more? problems are revstats requiring the zip file
        //     or recalculate values outside. select should also be removed and
        //     take a cell onclick callback or do the cell onclick in the caller?

        // Display the list of changes for the currently selected year as a
        // table with one color-coded cell per day of the year, similar to
        // github commit activity: one cell per day, one row per day of the
        // week, one column per week, multiple columns per month.

        const selectedEdit = select.getValue();
        const year = this.plugin.getEditDate(selectedEdit).getFullYear();
        
        let calendarHtml = '<table class="calendar">';
        let fileTimeToEditCount = new Map<number, number>();
        let fileSize = 0;
        let numFiles = 0;

        // Collect the times of all edits in the given year, note it's possible
        // filepaths is empty when the file hasn't been saved yet. 
        // XXX Ideally this should also add the current time if note contents
        //     different from last stored, but this needs the cell clicking code
        //     to be able to respond to that date. Eventually this function
        //     should just take a list of days and shades, or the shade and
        //     clicking done in the caller after calendar building? 
        for (let fp of filepaths) {
            // XXX filepaths are sorted by decreasing date, could binary search
            //     to the selected year, probably overkill?
            let d = this.plugin.getEditDate(fp);
            if (d.getFullYear() == year) {
                const t = this.plugin.getEditFileTime(fp);
                const count = fileTimeToEditCount.get(t) || 0;
                fileTimeToEditCount.set(t, count + 1);
                fileSize += this.plugin.getEditCompressedSize(zip, fp);
                numFiles++;
            } else if (d.getFullYear() < year) {
                // filepaths are sorted newest first, exit when switching
                // to a previous year
                break;
            }
        }
        // Shade the days looking at how many edits there were for the given day
        // Note this doesn't count diffs inside an edit, but edits in a day,
        // since counting diffs would require uncompressing and parsing all
        // edits in the day, which is expensive
        const editCounts = Array.from(fileTimeToEditCount.values());
        const maxFileEditCount = Math.max(...editCounts);
        const minFileEditCount = Math.min(...editCounts);
        const editCountRange = maxFileEditCount - minFileEditCount;
        const maxShade = 5; // From 0 to maxShade shade levels
        const selectedFileTime = this.plugin.getEditFileTime(selectedEdit);
        const firstDayOfYear = new Date(year, 0, 1);
        const startDate = new Date(year, 0, 1 - firstDayOfYear.getDay());
        // one row per day of the week
        const numRows = 7;
        // Check if the last day of February is 29 by setting the day of the
        // March (0-based) to 0, which typescript adjusts to the last day of the
        // previous month
        const leapDelta =  new Date(year, 2, 0).getDate() - 28;
        // need to show at least 365 days plus padding for previous year
        // plus leap
        const numCols = Math.round((365 + firstDayOfYear.getDay() + leapDelta) / numRows);
        
        let month = 0;
        let monthColStart = 0;
        calendarHtml += `<thead><tr><th>${year}</th>`;
        
        // Generate the HTML for the month column headers, each month is a
        // variable number of columns depending on the day of the week the first
        // day of the month falls in and the length of the month in days
        
        // set d at the bottom row, will indicate when the current column spills
        // to the next month and a new column header is needed
        let d = new Date(startDate);
        d.setDate(d.getDate() + 6);
        for (let col = 0; col < numCols; ++col) {
            // Spill the previous month if this column ends in a new month, this
            // is done after the fact since that's when colspan is known, so it
            // also needs to spill if the last column
            if ((month != d.getMonth()) || (col == numCols - 1)) {
                const dd = new Date(d.getFullYear(), month, 1);
                calendarHtml += `<th colspan="${(col - monthColStart)}">${dd.toLocaleDateString(undefined, { month: 'short' })}</th>`;
                monthColStart = col;
                month = d.getMonth();
            }
            d.setDate(d.getDate() + 7);
        }
        calendarHtml += "</tr></thead><tbody>";

        // Generate HTML for the day cells, one cell per day, one day of the
        // week per row, one week per column
        for (let row = 0; row < numRows; ++row) {
            let d =  new Date(startDate);
            // It's okay to overflow days in setDate, Typescript does carry over
            d.setDate(d.getDate() + row);
            calendarHtml += `<tr><th>${d.toLocaleDateString(undefined, { weekday: 'short' })}</th>`;
            for (let col = 0; col < numCols; ++col) {
                const t = d.getTime();
                const count = fileTimeToEditCount.get(t) || 0;
                // Note month is 0-based
                let styleClass = "calendar-empty-"  +  ((d.getMonth() & 1) ? "odd" : "even");
                let tooltip = d.toLocaleDateString();
                if (d.getFullYear() != year) {
                    // Note count is zero in this case, since only times in the
                    // current year are counted
                    styleClass = "calendar-black";
                } else if (count > 0) {
                    const shadeLevel = (editCountRange == 0) ? maxShade : Math.round(((count-minFileEditCount) * maxShade) / editCountRange);
                    if (t == selectedFileTime) {
                        styleClass = "calendar-selected ";
                    } else {
                        styleClass = "calendar-level ";
                    }
                    styleClass += "clickable level-" + shadeLevel;
                    tooltip += ` (${count} edits)`;
                } 
                calendarHtml += `<td id="calendar-${t}" class="${styleClass}" title="${tooltip}"></td>`;
                d.setDate(d.getDate()+7);
            }
            calendarHtml += "</tr>";
        }
        calendarHtml += "</tbody></table>";
        calendarDiv.innerHTML = calendarHtml;
        const calendarTable = calendarDiv.querySelector("table") as HTMLElement;
        // Hook on cell click to change the cell selection and the drop down (on
        // unselected but also on selected cells, since cell selection can be
        // toggled without regenerating the whole calendar)
        const cells = calendarTable.querySelectorAll('td.calendar-level, td.calendar-selected');
        cells.forEach(cell => {
            // Set the onclick handler
            cell.addEventListener('click', () => {
                // Select the first date that matches in the drop down (since
                // this is a date without time, there can be multiple matching
                // diffs in the same day). No need to toggle the cell selection
                // itself since the dropdown change handler takes care of that
                logDbg('Cell clicked:', cell);
                const cellFileTime = parseInt(cell.id.slice(cell.id.indexOf("-")+1));
                // XXX store data-filetime in the option and do this search with
                //     queryselector?
                //     document.querySelector(`[data-filetime="${cellFileTime}"]`);
                const selectEl = select.selectEl;
                const options = selectEl.options;
                for (let i = 0; i < options.length; i++) {
                    let d = this.plugin.getEditDate(options[i].value);
                    d = new Date(d.getFullYear(), d.getMonth(), d.getDate());
                    const optionFileTime = d.getTime();
                    if (optionFileTime == cellFileTime) {
                        if (i != selectEl.selectedIndex) {
                            selectEl.selectedIndex = i;
                            selectEl.trigger("change");
                        }
                        break;
                    }
                }
            });
        });
        let revStats = calendarDiv.createEl("small");
        // Fill in the stats now that all the information is available
        // XXX Use human friendly units (KB, MB, GB, etc)
        revStats.setText(
            `${numFiles}/${filepaths.length} edit${(filepaths.length > 1) ? "s " : " "}` +
            `${fileSize}/${(zipFile as TFile).stat.size} bytes compressed, ${this.app.workspace.getActiveFile()?.stat.size} note bytes`
        );
    }

    async renderDiffsTimeline(zip: JSZip, dmpobj: DiffMatchPatch, filepaths: string[], selectedEdit: string, latestData: string, showWhitespace: boolean): Promise<string> {
        
        let annots : string[] = [];
        let lineToRefLine : number[] = [];
        let lines : string[] = [];
        let annotate = false;
        let remainingAnnots = 0;
        let data = latestData;
        let newerData = latestData;
        let prevFileDateStr = "";
        
        let notice = null;

        let nextReportPct = 0;
        const reportIntervalPct = 5;
        const startTime = Date.now();
        for (const [ifp, filepath] of filepaths.entries()) {
            // Timeline can take a long time with lots of edits, report, but
            // only every few iterations to avoid unnecessary overhead
            // XXX Find a way to allow cancel?
            // XXX Decrease execution time by doing coarse timeline that only
            //     shows per day diffs? (merge all edits done the same day,
            //     rebuilding the diff in a single call and pointing the click
            //     to the first or last edit of that day)
            const pct = Math.round((100*ifp)/filepaths.length);
            if (pct >= nextReportPct) {
                if (nextReportPct == reportIntervalPct) {
                    // On the first progress report, check if the estimate of
                    // the whole work will be over a given threshold (this
                    // prevents the notice quickly flashing with files with few
                    // edits) and report if so
                    const currentTime = Date.now();
                    if (((currentTime - startTime) * 100 / nextReportPct) > 1000) {
                        // Create a notice to report progress, set duration to
                        // zero to prevent the notice from disappearing while
                        // still working, hide explicitly below when done.
                        notice = new Notice("", 0);
                    }
                }
                // Note this may not reach 100% if the loop early exists below,
                // but it's very unlikely
                notice?.setMessage(`Computing timeline ${pct}%`);
                nextReportPct += reportIntervalPct;
            }
            // Loop over filepaths,
            // - first rebuilding the file contents for the selectedEdit
            // - once found, keep rebuilding versions and also store the time
            //   annotation for each line (ie time of the edit that most
            //   recently modified that line)
            const diff = await zip.file(filepath).async("string");
            newerData = data;
            if (this.plugin.getEditIsDiff(filepath)) {
                // Rebuild the data from the diff applied to the current data
                const patch = dmpobj.patch_fromText(diff);
                data = dmpobj.patch_apply(patch, data)[0];
            } else {
                // The full file was stored, there's no diff
                data = diff;
            }
            if (!annotate && (selectedEdit == filepath)) {
                // Note split returns 2 for a string with a single \n, no need
                // to +1
                lines = data.split("\n");
                const numLines = lines.length;
                annots = new Array(numLines).fill("");
                // lineToRefLine[i] : for line i of the current data, what is
                // the line of the reference filepath. Could be -1 if the
                // reference filepath doesn't contain that line and could have
                // less than the reference lines if the current filepath doesn't
                // contain that line
                lineToRefLine = Array.from({ length: numLines + 1 }, (_, i) => i);
                annotate = true;
                prevFileDateStr = this.plugin.getEditLocalDateStr(filepath);  
                remainingAnnots = annots.length;
            } else if (annotate) {
                // Get the diff to go from the newer version to the older
                // version (backwards diff), so newer lines appear as deletions
                // and viceversa (this allows to replace the line diff with with
                // the stored diffs in the future, which also store a backwards
                // diff)
                // Use linemode since we are interested in full line changes,
                // but note that line diffs still include carriage returns
                // inside so they need to be looped over below
                // XXX This should use the patch and not recreate the diff, but
                //     patches are contextless and require tracking how lines
                //     are inserted or deleted as if the patch were applied
                const diffs = dmpobj.diff_lineMode(newerData, data);
                let line = 0;
                for (const [op, diffData] of diffs) {
                    // Counting diffs and diff_linemode above are by far the
                    // hotspots of this function (eg 280ms and 170ms each).
                    // For counting lines .split().length is 270ms vs.
                    // .match().length 346ms
                    const numLines = diffData.split("\n").length-1;
                    for (let i=0; i < numLines; ++i) {
                        const refLine = lineToRefLine[line];
                        switch (op as number) {
                            case DiffOp.Delete:
                                // If the old file doesn't have this line, it
                                // means the new file inserted the line, annotate
                                // as such unless it's already annotated
                                lineToRefLine.splice(line, 1);
                                if ((refLine != -1) && (annots[refLine] == "")) {
                                    annots[refLine] = prevFileDateStr;
                                    remainingAnnots--;
                                }
                            break;
                            case DiffOp.Insert:
                                // The new file doesn't have this line, it means
                                // the new file deleted it, nothing to annotate,
                                // but tag this line as not present 
                                lineToRefLine.splice(line, 0, -1);
                                line++;
                            break;
                            case DiffOp.Equal:
                                line++;
                            break;
                        }
                        // Early exit if all the lines have annotations. This is
                        // unlikely to hit unless at some point the whole file
                        // was rewritten
                        if (remainingAnnots == 0) {
                            break;
                        }
                    }
                    if (remainingAnnots == 0) {
                        break;
                    }
                }
                prevFileDateStr = this.plugin.getEditLocalDateStr(filepath);
            }
        }

        // Generate a table with the annotated file, time annotations on the
        // left column and text lines on the right
        let diffHtml: string = "<table>";
        const fileDateStr = this.plugin.getEditLocalDateStr(selectedEdit);
        for (let i=0; i < lines.length; ++i) {
            const hdata1 = htmlEncode(annots[i], false);
            const hdata2 = htmlEncode(lines[i], showWhitespace);

            if (annots[i] == fileDateStr) {
                // If the annotation date is the selectedEdit, tag as diff-line
                // so it gets highlighted and can be navigated and counted as
                // diff for stats display (but can only tag insertions,
                // deletions are missing by definition of the timeline view)
                
                // XXX This causes the scroll to move when navigating by
                //     clicking the time because the first diff-line is focused
                //     when the select changes, which may undesirable since the
                //     clicked time line may be scrolled out, fix?
                diffHtml += `<tr class="diff-line"><td class="clickable diff-time">${hdata1}</td><td class="mod-right">${hdata2}</td></tr>`;
            } else {
                diffHtml += `<tr><td class="clickable diff-time ${(annots[i] == fileDateStr) ? "diff-line" : ""}">${hdata1}</td><td>${hdata2}</td></tr>`;
            }
        }
        diffHtml += "</table>";

        notice?.hide();

        return diffHtml;
    }

    renderDiffsInline(diffs: Diff[], showWhitespace: boolean): string {
        let diffHtml = "";
        // This is equivalent to diff_prettyHtml, but that one inserts
        // hard-coded background colors, use styles instead. See
        // https://github.com/google/diff-match-patch/blob/master/javascript/diff_match_patch_uncompressed.js
        for (const [op, data] of diffs) {
            // Some Insert/Delete diffs are empty independently of
            // calling diff_cleanupSemantic, ignore. See
            // https://github.com/google/diff-match-patch/issues/105
            if (data == "") {
                continue;
            }
            let hdata = htmlEncode(data, showWhitespace);
            switch (op as number) {
                case  DiffOp.Delete:
                    diffHtml += `<del class="diff-line mod-left">${hdata}</del>`;
                break;
                case DiffOp.Insert: 
                    diffHtml += `<ins class="diff-line mod-right">${hdata}</ins>`;
                break;
                case DiffOp.Equal:
                    diffHtml += `<span>${hdata}</span>`;
                break;
            }
        }
        return diffHtml;
    }

    renderDiffsSideOrTop(diffs: Diff[], sideBySide: boolean, showWhitespace: boolean): string {
        // Group the diffs by carriage-terminated blocks of lines,
        // display them in a table side by side or top by bottom

        // For every diff, 
        // - if it's an equal diff
        //   - Append the first line to the current right and left
        //     blocks, flush the blocks
        //   - Initialize left and right to the last line
        //   - Flush any in between lines as non-diff right and left
        //     blocks
        // - if it's a delete diff, accumulate into the left block
        // - if it's an insertion diff, accumulate into right block and
        //   flush if it ends in carriage return
        
        let left = "";
        let right = "";
        let diffHtml = '<table width="100%"><tbody>';
        // Append a dummy terminator to detect the loop end and flush
        for (const [op, data] of [...diffs, [DiffOp.Equal as number, ""] as Diff]) {
            // Some Insert/Delete diffs are empty independently of
            // calling diff_cleanupSemantic, ignore. See
            // https://github.com/google/diff-match-patch/issues/105
            // (don't remove empty Equal since it's used loop as
            // terminator below)
            if ((data == "") && ((op as number) != DiffOp.Equal)) {
                continue;
            }
            let hdata = htmlEncode(data, showWhitespace);
            // XXX Hack to guarantee a flush at the end, do it elsewhere
            //     since it will add an spurious (but invisible in html)
            //     carriage return
            if (hdata == "") {
                hdata = "\n";
            }
            switch (op as number) {
                case DiffOp.Delete:
                    left += `<del>${hdata}</del>`;
                    // Don't flush even if it ends in a carriage return,
                    // the right side is the one that tracks returns.
                    // This will pair the deletion to the next insertion
                    // or equal block (empirically looks like deletions
                    // always appear before insertions, so this seems to
                    // work fine).
                    
                    // XXX This could also assign deletions to the wrong
                    //     block, but it's not deterministic what the
                    //     proper block is anyway.
                break;
                case DiffOp.Insert:
                    right += `<ins>${hdata}</ins>`;
                    // Flush left and right if right ends in carriage
                    // return, otherwise wait for a carriage return
                    // either in an Insert or in an Equal diff. No need
                    // to flush each line individually since it's
                    // desirable to group the whole insertion in the
                    // same block
                    if (hdata.endsWith("\n")) {
                        if (sideBySide) {
                            diffHtml += `<tr class="diff-line"><td class="mod-left">${left}</td><td class="mod-right">${right}</td></tr>`;
                        } else {
                            diffHtml += `<tr class="diff-line"><td><div class="mod-left">${left}</div><div class="mod-right">${right}</td></tr>`;
                        }
                        left = "";
                        right = "";
                    }
                break;
                case DiffOp.Equal:
                    let i;
                    // Flush any pending left & right blocks upto the
                    // first carriage return in the equal data,
                    // inclusive
                    i = hdata.indexOf("\n");
                    if ((i != -1) && ((left != "") || (right != ""))) {
                        let end = hdata.slice(0, i+1);
                        left += end;
                        right += end;
                        hdata = hdata.slice(i+1);

                        if (sideBySide) {
                            diffHtml += `<tr class="diff-line"><td width="50%" class="mod-left">${left}</td><td width="50%" class="mod-right">${right}</td></tr>`;
                        } else {
                            diffHtml += `<tr class="diff-line"><td><div class="mod-left">${left}</div><div class="mod-right">${right}</div></td></tr>`;
                        }
                        left = "";
                        right = "";
                    }
                    // Flush all the equal data upto the last carriage
                    // return, inclusive
                    i = hdata.lastIndexOf("\n");
                    if (i != -1) {
                        let start = hdata.slice(0, i+1);
                        if (sideBySide) {
                            diffHtml += `<tr><td>${start}</td><td>${start}</td></tr>`;
                        } else {
                            diffHtml += `<tr><td>${start}</td></tr>`;
                        }
                        hdata = hdata.slice(i+1);
                    }
                    // Append to left and right the equal data from the
                    // last carriage return, exclusive 
                    right += hdata;
                    left += hdata;
                break;
            }
        }
        diffHtml += "</tbody></table>";
        
        return diffHtml;
    }

    async onOpen() {
        const file = this.app.workspace.getActiveFile();

        this.titleEl.setText("Edits for ");
        this.titleEl.createEl("i", { text: file?.name });
        this.titleEl.createEl("span", { text: " " });

        const calendarIcon = this.titleEl.createEl("span")
        // XXX This icon is not visible on mobile on some older versions,
        //     find out which version and increase the required version?
        setIcon(calendarIcon, "calendar-plus-2");
        
        this.modalEl.addClass("edit-history-modal");

        const {contentEl} = this;        
        contentEl.addClass("edit-history-modal-content");

        if ((file == null) || (!this.plugin.keepEditHistoryForFile(file))) {
            // XXX This should never happen since callers don't fire the modal?
            logWarn("Edit history not allowed for active file");
            contentEl.createEl("p", { text: "No edit history"});
            return;
        }

        // Note this may differ from the last edit stored in the zip since not
        // all edits are stored in the file depending on the value of
        // this.minMsBetweenEdits
        const latestData = await this.app.vault.read(file);
    
        // Create or open the zip with the edit history of this file

        // XXX Review perf notes at https://stuk.github.io/jszip/documentation/limitations.html
        const zip: JSZip = new JSZip();
        const zipFilepath = this.plugin.getEditHistoryFilepath(file.path);
        logInfo("Opening zip file ", zipFilepath);
        const zipFile = this.app.vault.getAbstractFileByPath(zipFilepath);
        if ((zipFile == null) || (!(zipFile instanceof TFile))) {
            logWarn("No history file or not a file", zipFilepath);
            contentEl.createEl("p", { text: "No edit history file"});
            return;
        }
        
        const zipData = await this.app.vault.readBinary(zipFile);
        if (zipData == null) {
            logWarn("Unable to read history file");
            contentEl.createEl("p", { text: "No edit history"});
            return;
        }

        await zip.loadAsync(zipData);

        const filepaths:string[] = [];
        zip.forEach(function (relativePath:string) {
            filepaths.push(relativePath);
        });
        if (filepaths.length == 0) {
            logWarn("Empty edit history file");
            contentEl.createEl("p", { text: "Empty edit history"});
            return;
        }
        // Sort most recent first (although probably unnecessary since the zip
        // seems to list in creation order already)
        this.plugin.sortEdits(filepaths);

        const dmpobj = new DiffMatchPatch();
        
        // XXX Allow searching in the diff text rendering

        const calendarDiv = contentEl.createDiv();
        // The calendar is too tall for mobile, allow collapsing/expanding
        calendarIcon.addEventListener('click', () => {
            if (calendarDiv.style.display === "none") {
                calendarDiv.style.display = "block";
                setIcon(calendarIcon, "calendar-minus-2");
            } else {
                calendarDiv.style.display = "none";
                setIcon(calendarIcon, "calendar-plus-2");
            }
        });

        const control = contentEl.createDiv("setting-item-control");
        control.style.justifyContent = "flex-start";
        const select = new DropdownComponent(control);
        select.selectEl.focus();

        const diffDisplaySelect = new DropdownComponent(control)
            .addOptions(diffDisplayFormatToString)
            .setValue(this.plugin.settings.diffDisplayFormat)
            .onChange(async () => {
                select.selectEl.trigger("change");
            });
        
        const diffInfo: HTMLElement = control.createEl("span");

        // XXX With the new buttons, this is too tall and too wide on mobile,
        //     reorganize/resize/downscale font?
        const copyButton = new ButtonComponent(control)
            .setButtonText("Copy")
            .setClass("mod-cta")
            .onClick(() => {
                logInfo("Copied to clipboard");
                navigator.clipboard.writeText(this.currentVersionData);
            });

        const prevButton = new ButtonComponent(control)
            .setButtonText("Previous")
            .setClass("mod-cta")
            .onClick(() => {
                logInfo("Prev diff");
                if (this.diffElements.length > 0) {
                    // XXX Disable button on start instead of cycling?
                    this.diffElements[this.curDiffIndex].removeClass("current");
                    this.curDiffIndex = (this.curDiffIndex + this.diffElements.length - 1) % this.diffElements.length;
                    this.diffElements[this.curDiffIndex].scrollIntoView({block: "center"});
                    this.diffElements[this.curDiffIndex].addClass("current");
                    diffInfo.setText((this.curDiffIndex + 1) + "/" + this.diffElements.length + " diff" + ((this.diffElements.length != 1) ? "s" : ""));
                }
            });

        const nextButton = new ButtonComponent(control)
            .setButtonText("Next")
            .setClass("mod-cta")
            .onClick(() => {
                logInfo("Next diff");
                if (this.diffElements.length > 0) {
                    // XXX Disable button on end instead of cycling?
                    this.diffElements[this.curDiffIndex].removeClass("current");
                    this.curDiffIndex = (this.curDiffIndex + 1) % this.diffElements.length;
                    this.diffElements[this.curDiffIndex].scrollIntoView({block: "center"});
                    this.diffElements[this.curDiffIndex].addClass("current");
                    diffInfo.setText((this.curDiffIndex + 1) + "/" + this.diffElements.length + " diff" + ((this.diffElements.length != 1) ? "s" : ""));
                }
            });

        control.createEl("span").setText("Whitespace");
        const whitespaceCheckbox = new ToggleComponent(control) 
            .setValue(this.plugin.settings.showWhitespace)
            .onChange(async () => {
                select.selectEl.trigger("change");
            });
        
        // Set tabindex to 0 so it can receive key events
        contentEl.setAttr("tabindex", 0);
        contentEl.addEventListener("keydown", (event: KeyboardEvent) => {
            // Hook on ctrl+arrow up/down and p/n for prev/next diff (don't use
            // alt+up/down since it's used to unfold dropdowns)
            logDbg("key", event);
            const navigateDiff = event.ctrlKey && !event.shiftKey;
            const navigateDate = event.ctrlKey && event.shiftKey;
            if ((event.key === "p") || (navigateDiff && (event.key === 'ArrowUp'))) {
                event.preventDefault();
                prevButton.buttonEl.trigger("click");
            } else if ((event.key === "P") || (navigateDate && (event.key === 'ArrowUp'))) {
                event.preventDefault();
                const nextIndex = select.selectEl.selectedIndex - 1;
                if (nextIndex >= 0) {
                    select.selectEl.selectedIndex = nextIndex;
                    select.selectEl.trigger("change");
                }
            } else if ((event.key === "n")  || (navigateDiff && (event.key === 'ArrowDown'))) {
                event.preventDefault();
                nextButton.buttonEl.trigger("click");
            } else if ((event.key === "N") || (navigateDate && (event.key === 'ArrowDown'))) {
                event.preventDefault();
                const nextIndex = select.selectEl.selectedIndex + 1;
                if (nextIndex < select.selectEl.options.length) {
                    select.selectEl.selectedIndex = nextIndex;
                    select.selectEl.trigger("change");
                }
            } else if ((event.key === "c") && event.ctrlKey) {
                event.preventDefault();
                copyButton.buttonEl.trigger("click");
            }
        });
        
        const diffDiv = contentEl.createDiv("diff-div");
        let selectedDayCell : HTMLElement|null = null;
        select.onChange( async () => {
            // This is called implicitly from the event dispatcher but also
            // explicitly via .trigger()
            // XXX Abstract out instead?
            const selectedEdit = select.getValue();

            // Update the selected cell or the whole calendar if the cell is not
            // found (ie calendar not rendered yet or year changed)
            const selectedFileTime = this.plugin.getEditFileTime(selectedEdit);
            const dayCell = document.getElementById(`calendar-${selectedFileTime}`) as HTMLElement|null;
            if (dayCell) {
                // Calendar already generated, highlight the new cell and
                // lowlight the old one
                if (selectedDayCell) {
                    selectedDayCell.addClass("calendar-level");
                    selectedDayCell.removeClass("calendar-selected");
                }
                selectedDayCell = dayCell;
                selectedDayCell.addClass("calendar-selected");
                selectedDayCell.removeClass("calendar-level");
            } else {
                this.renderCalendar(calendarDiv, select, zipFile as TFile, zip, filepaths);
                selectedDayCell = document.getElementById(`calendar-${selectedFileTime}`) as HTMLElement|null;
            }

            // Rebuild the file data of the given edit by applying the patches
            // in reverse, if one of the edits is stored fully, discard the
            // accumulated patched data and use the full data
            let data = latestData;
            let currentData = latestData;
            let currentDiff = null;

            // XXX This should cache currentData so sequentially traversing
            //     filepaths doesn't need to recreate this, and even if it's not
            //     sequential going to an earlier date can be done faster by
            //     using a non-current previousData. Only do it for the lifetime
            //     of the modal, so no need to keep one per each edited file.
            let found = false;
            let previousFound = false;
            for (let filepath of filepaths) {
                // filepath contains the negative backward diff to go from the
                // immediately newer date to filepath's date, need to
                // reconstruct the data upto the selected filepath and also the
                // immediately older one so the positive forward diff from older
                // to selected can be displayed
                let diff = await zip.file(filepath).async("string");
                
                if (this.plugin.getEditIsDiff(filepath)) {
                    // Rebuild the data from the diff applied to the current
                    // data
                    let patch = dmpobj.patch_fromText(diff);
                    // XXX This could collect patches and apply them in a
                    //     single call after the loop, not clear it's faster
                    data = dmpobj.patch_apply(patch, data)[0];
                } else {
                    // The full file was stored, there's no diff
                    data = diff;
                }

                if (found) {
                    previousFound = true;
                    break;
                }
                found = (selectedEdit == filepath);

                currentDiff = diff;
                currentData = data;
            }
            
            // If selectedEdit is the oldest edit, it won't find a previous one
            // to diff against, assume the previous is the empty file and diff
            // against that (this will be incorrect if the plugin wasn't enabled
            // when this file was created and already contained text, but
            // there's nothing that can be done in that case)
            if (!previousFound) {
                data = "";
            }

            // Display the diff against the latest edit
            // XXX Have an option to diff against an arbitrary non-sequential edit?
            // XXX This redoes the diff which shouldn't be necessary since
            //     we have all the patches, but it's not clear how to
            //     convert from patch to diff, looks like patch.diff is the
            //     set of diffs for a given patch? (but will still need to 
            //     re-diff when the whole file is saved instead of the diff)
            // XXX Add fold/unfold before/after context lines to the UI like
            //     file recovery does
            let diffHtml = "";
            // Store the currently selected version so it can be copied to
            // clipboard from the copy button handler
            this.currentVersionData = currentData;
            const showWhitespace = whitespaceCheckbox.getValue();
            // For side by side, getting line diffs via diff_lineMode could be
            // used instead which would avoid having to find line breaks below,
            // but using diff_main allows highlighting char-level diffs inside
            // each line 
            const diffs = dmpobj.diff_main(data, currentData);
            dmpobj.diff_cleanupSemantic(diffs);
            const diffDisplayFormat = diffDisplaySelect.getValue() as DiffDisplayFormat;
            switch (diffDisplayFormat) {
                case DiffDisplayFormat.Raw:
                    // XXX Missing setting the 1/n diffcount that is displayed
                    //     by the dropdowns (maybe by counting @@ and dividing
                    //     by 2?), but it's currently extracted from
                    //     diffElements.length, so that needs changing

                    // Note raw display of the diff looks counter-intuitive
                    // because the diff stores the difference between the
                    // version newer than filepath and filepath, which is a
                    // "negative forward" diff. Arguably it should show the
                    // "positive backward" diff between filepath and the version
                    // previous to filepath, but then it's not "raw"
                    let hdata = htmlEncode(currentDiff, showWhitespace);
                    diffHtml = "<tt>" + hdata + "</tt>";
                break;
                case DiffDisplayFormat.Timeline:
                    diffHtml = await this.renderDiffsTimeline(zip, dmpobj, filepaths, selectedEdit, latestData, showWhitespace);
                break;
                case DiffDisplayFormat.Inline:
                    diffHtml = this.renderDiffsInline(diffs, showWhitespace);
                break;
                default:
                    const sideBySide = (diffDisplayFormat == DiffDisplayFormat.Horizontal);
                    diffHtml = this.renderDiffsSideOrTop(diffs, sideBySide, showWhitespace);
                break;
            }
            // Remove carriage returns since <br> have been added in htmlEncode
            // XXX Do this in htmlEncode but \n can't be removed right away
            //     since it's used to detect end of line in side by side
            //     displays above
            // XXX Removing carriage returns seems to be needed because in
            //     styles.css .diff-div uses pre-wrap instead of just wrap in
            //     order to preserve spaces/tabs so diff of a space is still
            //     visible, but don't want to show carriage returns since
            //     htmlEncode has converted them to <br>\n. Convert spaces/tabs
            //     to nbsp in htmlEncode? Don't convert to <br> in htmlEncode?
            diffHtml = diffHtml.replace(/\n/g, "");
            
            // XXX Make colors configurable, in modal setting or per theme
            //     light/dark
            //     See https://github.com/friebetill/obsidian-file-diff/issues/1#issuecomment-1425157959
            // XXX Have a button to roll back to version
            // XXX innerHTML is discouraged for security reasons, change?
            //     (note this is safe because diffHtml is escaped)
            //     See https://github.com/obsidianmd/obsidian-releases/blob/master/plugin-review.md#avoid-innerhtml-outerhtml-and-insertadjacenthtml
            // XXX This is a performance hotspot, calls the internal parseHtml,
            //     not clear this can be done faster by creating nodes manually
            //     instead (chatgpt actually says parsing is faster). Creating
            //     nodes and storing them would also also avoid calling
            //     querySelectorAll below which is also a hotspot
            diffDiv.innerHTML = diffHtml;
            // Diffs are spans of <ins> or <del> tags, scroll to the first one
            this.curDiffIndex = 0;
            // diffElements is used for navigating prev/next diffs in all diff
            // displays but Raw. diff-line marks added/deleted lines in side by
            // side/top by bottom, individual changes in inline, and added lines
            // in timeline
            const diffElements = diffDiv.querySelectorAll<HTMLElement>(".diff-line");
            this.diffElements = diffElements;
            this.diffElements[this.curDiffIndex]?.scrollIntoView({block: "center"});
            this.diffElements[this.curDiffIndex]?.addClass("current");
            // XXX Number of diffs is ok for navigating but not a great
            //     statistic, this could also show chars added/chars deleted?
            diffInfo.setText((this.curDiffIndex + 1) + "/" + this.diffElements.length + " diff" + ((this.diffElements.length != 1) ? "s" : ""));
            // Navigate edits on click in the timeline view
            // XXX Clicking navigates the timeline "backwards", have a way of
            //     navigating forwards?
            const table = diffDiv.querySelector("table");
            const cells = table?.querySelectorAll("td.diff-time");
            cells?.forEach(cell => {
                // Set the onclick handler
                cell.addEventListener('click', () => {
                    logDbg('Cell clicked:', cell);
                    // cell contents are in the same format as the drop down
                    const text = cell.textContent as string;
                    // Select the first date that matches in the drop down
                    // (since this is a date without time, there can be multiple
                    // matching diffs in the same day)
                    const selectEl = select.selectEl;
                    const options = selectEl.options;
                    for (let i = 0; i < options.length; i++) {
                        if (options[i].text == text) {
                            if (i != selectEl.selectedIndex) {
                                selectEl.selectedIndex = i;
                                selectEl.trigger("change");
                            }
                            break;
                        }
                    }
                });
            });
        });

        // Create option entries
        for (let filepath of filepaths) {
            // XXX The drop down displays the changes between the selected
            //     date and the immediately older date
            //     This means that:
            //      -  the first entry should be a dummy entry with the current
            //         contents date that displays the diff from the current
            //         contents to the first file in the history (probably no
            //         changes if a revision was recently saved)
            //      - the last entry is a diff from that entry's date to the 
            //        empty file
            //     Missing setting the first dummy entry
            select.addOption(filepath, this.plugin.getEditLocalDateStr(filepath));
        }
        // Force initialization done inside onChange
        select.selectEl.trigger("change");
        
        // Update the status bar
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

        containerEl.createEl("small", { text: "Created by "})
            .appendChild(createEl("a", { text: "Antonio Tejada", href:"https://github.com/antoniotejada/"}));

        // h2 is abnormally small in settings, start with h3 which has the right
        // size (other plugins do the same)
        containerEl.createEl("h3", {text: "General"});

        new Setting(containerEl)
            .setName("Minimum seconds between edits")
            .setDesc("Minimum number of seconds that must pass from the previous edit to store a new edit, set to 0 to disable. Modifications done between those seconds will be merged into the next edit, reducing the edit history file size at the expense of less history granularity.")
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
            .setDesc("Comma separated list of file extensions to store edits for (case insensitive). Empty to store edits for all files.\nNote if an extension is removed, old edit history files will need to be removed manually.")
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.extensionWhitelist)
                .setValue(this.plugin.settings.extensionWhitelist)
                .onChange(async (value) => {
                    logInfo("File extension whitelist: " + value);
                    this.plugin.settings.extensionWhitelist = value;
                    await this.plugin.saveSettings();
                }));
                
        new Setting(containerEl)
                .setName("Filepath substring blacklist")
                .setDesc("Comma separated list of substrings of note filepaths to not store edits for (case insensitive). Empty to store edits for all files.\nUse forward slashes as folder separator\nNote if a substring is added, old edit history files will need to be removed manually.")
                .addText(text => text
                    .setPlaceholder(DEFAULT_SETTINGS.substringBlacklist)
                    .setValue(this.plugin.settings.substringBlacklist)
                    .onChange(async (value) => {
                        logInfo("File substring blacklist: '" + value + "'");
                        this.plugin.settings.substringBlacklist = value;
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

        new Setting(containerEl)
            .setName("Diff display type")
            .setDesc("In the diff view, display the diff raw, timeline, inline, horizontally (side by side), or vertically (top by bottom).")
            .addDropdown(dropdown => dropdown
                .addOptions(diffDisplayFormatToString)
                .setValue(this.plugin.settings.diffDisplayFormat)
                .onChange(async (value) => {
                    logInfo("Diff display position: " + value);
                    this.plugin.settings.diffDisplayFormat = value;
                    await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName("Show whitespace")
            .setDesc("Show whitespace in the diff view.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showWhitespace)
                .onChange(async (value) => {
                    logInfo("Show whitespace: " + value);
                    this.plugin.settings.showWhitespace = value;
                    await this.plugin.saveSettings();
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
              .onChange(async (value) => { logInfo("onChange"); logInfo('Edits
              folder: ' + value); // Only allow top level folders

                    this.plugin.settings.editHistoryRootFolder = value;


            XXX Can the folder just be renamed via the file explorer
            interface? 

            XXX Check no dir component starts with "." 

            XXX Delete edits? copy them to new folder? trash them? 

            XXX Ask the user to delete folder? 

            XXX Ask for confirmation? 

            XXX Use private apis to store in some hidden folder? 

            XXX This could use the adapter apis instead of the vault apis //
            be able to access the .obsidian dir? (or any other?)

            XXX The directory doesn't need to be created on every keystroke,
            it could have a create/commit button?
        */


}
}
