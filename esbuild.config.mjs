import esbuild, { build } from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import fs from "fs";
import path from "path";

function copyArtifactsToDirectory(artifacts, dirpath) {
    console.log("Copying artifacts to dirpath", dirpath);
    try {
        //console.debug("Creating dir", dirpath);
        fs.mkdirSync(dirpath).catch(() => null);
    } catch {
    }
    for (let artifact of artifacts) {
        const outFilepath = path.join(dirpath, artifact);
        //console.debug("copying", artifact, "to", outFilepath);
        fs.copyFileSync(artifact, outFilepath);	
    }
}

function copyArtifactsToVaults(artifacts) {
    if (process.platform != "win32") {
        // XXX configFilePath is only implemented for Win32, other OSs not
        //     supported yet
        console.warn("Copying artifacts to vaults only supported on Windows, copy manually");
        return;
    }
    let configFilepath = path.join(process.env.APPDATA , "obsidian", "obsidian.json");
    let configData = fs.readFileSync(configFilepath, "utf8");
    let config = JSON.parse(configData);

    let manifestData = fs.readFileSync("manifest.json", "utf8");
    let manifest = JSON.parse(manifestData);

    for (let id in config.vaults) {
        let vault = config.vaults[id];
        if (vault.path.endsWith(path.sep + "Obsidian Sandbox")) {
            //console.debug("Ignoring sandbox");
            continue;
        }
        let dirpath = path.join(vault.path, ".obsidian", "plugins",  manifest.id);
        copyArtifactsToDirectory(artifacts, dirpath);
    }
}

const banner =
`/*
THIS IS A GENERATED/BUNDLED FILE BY ESBUILD
if you want to view the source, please visit the github repository of this plugin
*/
`;

const prod = (process.argv[2] === "production");

const context = await esbuild.context({
    banner: {
        js: banner,
    },
    entryPoints: ["main.ts"],
    bundle: true,
    external: [
        "obsidian",
        "electron",
        "@codemirror/autocomplete",
        "@codemirror/collab",
        "@codemirror/commands",
        "@codemirror/language",
        "@codemirror/lint",
        "@codemirror/search",
        "@codemirror/state",
        "@codemirror/view",
        "@lezer/common",
        "@lezer/highlight",
        "@lezer/lr",
        ...builtins],
    format: "cjs",
    target: "es2018",
    logLevel: "info",
    sourcemap: prod ? false : "inline",
    treeShaking: true,
    outfile: "main.js",
});

let artifacts = ["main.js", "manifest.json"];

if (prod) {
    let buildResult = await context.rebuild();
    if ((buildResult.errors.length == 0) && (buildResult.warnings.length == 0)) {
        copyArtifactsToVaults(artifacts);
        
        let manifestData = fs.readFileSync("manifest.json", "utf8");
        let manifest = JSON.parse(manifestData);
        copyArtifactsToDirectory(artifacts, path.join("releases", manifest.version));
    }
    process.exit(0);
} else {
    await context.watch();
}