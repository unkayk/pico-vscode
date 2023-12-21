import {
  cp,
  createWriteStream,
  existsSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "fs";
import { mkdir } from "fs/promises";
import { homedir, tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import { join as joinPosix } from "path/posix";
import Logger from "../logger.mjs";
import { get } from "https";
import type { SupportedToolchainVersion } from "./toolchainUtil.mjs";
import { exec } from "child_process";
import { cloneRepository, initSubmodules } from "./gitUtil.mjs";
import { checkForInstallationRequirements } from "./requirementsUtil.mjs";
import { Octokit } from "octokit";
import { HOME_VAR, SettingsKey } from "../settings.mjs";
import type Settings from "../settings.mjs";
import AdmZip from "adm-zip";
import type { VersionBundle } from "./versionBundles.mjs";
import MacOSPythonPkgExtractor from "./macOSUtils.mjs";
import which from "which";
import { window } from "vscode";
import { fileURLToPath } from "url";

/// Translate nodejs platform names to ninja platform names
const NINJA_PLATFORMS: { [key: string]: string } = {
  darwin: "mac",
  linux: "lin",
  win32: "win",
};

/// Translate nodejs platform names to ninja platform names
const OPENOCD_PLATFORMS: { [key: string]: string } = {
  darwin: "mac",
  linux: "lin",
  win32: "x64-standalone",
};

/// Translate nodejs platform names to cmake platform names
const CMAKE_PLATFORMS: { [key: string]: string } = {
  darwin: "macos",
  linux: "linux",
  win32: "windows",
};

export function buildToolchainPath(version: string): string {
  // TODO: maybe put homedir() into a global
  return joinPosix(homedir(), ".pico-sdk", "toolchain", version);
}

export function buildSDKPath(version: string): string {
  // TODO: maybe replace . with _
  return joinPosix(
    homedir().replaceAll("\\", "/"),
    ".pico-sdk",
    "sdk",
    version
  );
}

export function buildToolsPath(version: string): string {
  // TODO: maybe replace . with _
  return joinPosix(
    homedir().replaceAll("\\", "/"),
    ".pico-sdk",
    "tools",
    version
  );
}

export function getScriptsRoot(): string {
  return joinPosix(
    dirname(fileURLToPath(import.meta.url)).replaceAll("\\", "/"),
    "..",
    "scripts"
  );
}

export function buildNinjaPath(version: string): string {
  return joinPosix(
    homedir().replaceAll("\\", "/"),
    ".pico-sdk",
    "ninja",
    version
  );
}

export function buildOpenOCDPath(version: string): string {
  return joinPosix(
    homedir().replaceAll("\\", "/"),
    ".pico-sdk",
    "openocd",
    version
  );
}

export function buildCMakePath(version: string): string {
  return joinPosix(
    homedir().replaceAll("\\", "/"),
    ".pico-sdk",
    "cmake",
    version
  );
}

export function buildPython3Path(version: string): string {
  return joinPosix(
    homedir().replaceAll("\\", "/"),
    ".pico-sdk",
    "python",
    version
  );
}

function tryUnzipFiles(zipFilePath: string, targetDirectory: string): boolean {
  let success = true;
  const zip = new AdmZip(zipFilePath);
  const zipEntries = zip.getEntries();
  zipEntries.forEach(function (zipEntry) {
    if (!zipEntry.isDirectory) {
      try {
        zip.extractEntryTo(zipEntry, targetDirectory, true, true, true);
      } catch (error) {
        Logger.log(
          `Error extracting archive file: ${
            error instanceof Error ? error.message : (error as string)
          }`
        );
        success = false;
      }
    }
  });

  return success;
}

function unzipFile(
  zipFilePath: string, targetDirectory: string,
  enforceSuccess: boolean = true
): boolean {
  try {
    if (enforceSuccess) {
      const zip = new AdmZip(zipFilePath);
      zip.extractAllTo(targetDirectory, true, true);
    } else {
      tryUnzipFiles(zipFilePath, targetDirectory);
    }

    // TODO: improve this
    const targetDirContents = readdirSync(targetDirectory);
    const subfolderPath =
      targetDirContents.length === 1
        ? join(targetDirectory, targetDirContents[0])
        : "";
    if (
      process.platform === "win32" &&
      targetDirContents.length === 1 &&
      statSync(subfolderPath).isDirectory()
    ) {
      readdirSync(subfolderPath).forEach(item => {
        const itemPath = join(subfolderPath, item);
        const newItemPath = join(targetDirectory, item);

        // Use fs.renameSync to move the item
        renameSync(itemPath, newItemPath);
      });
      rmdirSync(subfolderPath);
    }

    return true;
  } catch (error) {
    Logger.log(
      `Error extracting archive file: ${
        error instanceof Error ? error.message : (error as string)
      }`
    );

    return false;
  }
}

/**
 * Extracts a .xz file using the 'tar' command.
 *
 * Also supports tar.gz files.
 *
 * Linux and macOS only.
 *
 * @param xzFilePath
 * @param targetDirectory
 * @returns
 */
async function unxzFile(
  xzFilePath: string,
  targetDirectory: string
): Promise<boolean> {
  if (process.platform === "win32") {
    return false;
  }

  return new Promise<boolean>(resolve => {
    try {
      // Construct the command to extract the .xz file using the 'tar' command
      // -J option is redundant in modern versions of tar, but it's still good for compatibility
      const command = `tar -x${
        xzFilePath.endsWith(".xz") ? "J" : "z"
      }f "${xzFilePath}" -C "${targetDirectory}"`;

      // Execute the 'tar' command in the shell
      exec(command, error => {
        if (error) {
          Logger.log(`Error extracting archive file: ${error?.message}`);
          resolve(false);
        } else {
          // Assuming there's only one subfolder in targetDirectory
          const subfolder = readdirSync(targetDirectory)[0];
          const subfolderPath = join(targetDirectory, subfolder);

          // Move all files and folders from the subfolder to targetDirectory
          readdirSync(subfolderPath).forEach(item => {
            const itemPath = join(subfolderPath, item);
            const newItemPath = join(targetDirectory, item);

            // Use fs.renameSync to move the item
            renameSync(itemPath, newItemPath);
          });

          // Remove the empty subfolder
          rmdirSync(subfolderPath);

          Logger.log(`Extracted archive file: ${xzFilePath}`);
          resolve(true);
        }
      });
    } catch (error) {
      resolve(false);
    }
  });
}

export async function downloadAndInstallSDK(
  version: string,
  repositoryUrl: string,
  settings: Settings,
  python3Path?: string
): Promise<boolean> {
  let gitExecutable: string | undefined =
    settings
      .getString(SettingsKey.gitPath)
      ?.replace(HOME_VAR, homedir().replaceAll("\\", "/")) || "git";

  // TODO: this does take about 2s - may be reduced
  const requirementsCheck = await checkForInstallationRequirements(
    settings,
    gitExecutable
  );
  if (!requirementsCheck) {
    return false;
  }

  const targetDirectory = buildSDKPath(version);

  // Check if the SDK is already installed
  if (existsSync(targetDirectory)) {
    Logger.log(`SDK ${version} is already installed.`);

    return true;
  }

  // Ensure the target directory exists
  //await mkdir(targetDirectory, { recursive: true });
  const gitPath = await which(gitExecutable, { nothrow: true });
  if (gitPath === null) {
    // if git is not in path then checkForInstallationRequirements
    // maye downloaded it, so reload
    settings.reload();
    gitExecutable = settings
      .getString(SettingsKey.gitPath)
      ?.replace(HOME_VAR, homedir().replaceAll("\\", "/"));
    if (gitExecutable === null) {
      Logger.log("Error: Git not found.");

      await window.showErrorMessage(
        "Git not found. Please install and add to PATH or " +
          "set the path to the git executable in global settings."
      );

      return false;
    }
  }
  // using deferred execution to avoid git clone if git is not available
  if (
    gitPath !== null &&
    (await cloneRepository(
      repositoryUrl,
      version,
      targetDirectory,
      gitExecutable
    ))
  ) {
    settings.reload();
    // check python requirements
    const python3Exe: string =
      python3Path ||
      settings
        .getString(SettingsKey.python3Path)
        ?.replace(HOME_VAR, homedir().replaceAll("\\", "/")) ||
      (process.platform === "win32" ? "python" : "python3");
    const python3: string | null = await which(python3Exe, { nothrow: true });

    if (python3 === null) {
      Logger.log(
        "Error: Python3 is not installed and could not be downloaded."
      );

      void window.showErrorMessage("Python3 is not installed and in PATH.");

      return false;
    }

    return initSubmodules(targetDirectory, gitExecutable);
  }

  return false;
}

export function downloadAndInstallTools(
  version: string,
): boolean {
  const targetDirectory = buildToolsPath(version);

  // Check if the SDK is already installed
  if (existsSync(targetDirectory)) {
    Logger.log(`SDK Tools ${version} is already installed.`);

    return true;
  }

  // Check we are on a supported OS
  if (process.platform !== "win32" ||
        (process.platform === "win32" && process.arch !== "x64")) {
    Logger.log("Not installing SDK Tools as not on windows");

    return true;
  }

  Logger.log(`Installing SDK Tools ${version}`);

  // Ensure the target directory exists
  // await mkdir(targetDirectory, { recursive: true });

  cp(joinPosix(getScriptsRoot(), `tools/${version}`),
    targetDirectory,
    { recursive: true }, function(err) {
      Logger.log(err?.message || "No error");
      Logger.log(err?.code || "No code");
      resolve();
    }
  );

  return true;
}

export async function downloadAndInstallToolchain(
  toolchain: SupportedToolchainVersion,
  redirectURL?: string
): Promise<boolean> {
  const targetDirectory = buildToolchainPath(toolchain.version);

  // Check if the SDK is already installed
  if (redirectURL === undefined && existsSync(targetDirectory)) {
    Logger.log(`Toolchain ${toolchain.version} is already installed.`);

    return true;
  }

  // Ensure the target directory exists
  await mkdir(targetDirectory, { recursive: true });

  // select download url for platform()_arch()
  const platformDouble = `${process.platform}_${process.arch}`;
  const downloadUrl = redirectURL ?? toolchain.downloadUrls[platformDouble];
  const basenameSplit = basename(downloadUrl).split(".");
  let artifactExt = basenameSplit.pop();
  if (artifactExt === "xz" || artifactExt === "gz") {
    artifactExt = basenameSplit.pop() + "." + artifactExt;
  }

  if (artifactExt === undefined) {
    return false;
  }

  const tmpBasePath = join(tmpdir(), "pico-sdk");
  await mkdir(tmpBasePath, { recursive: true });
  const archiveFilePath = join(
    tmpBasePath,
    `${toolchain.version}.${artifactExt}`
  );

  return new Promise(resolve => {
    const requestOptions = {
      headers: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        "User-Agent": "VSCode-RaspberryPi-Pico-Extension",
        // eslint-disable-next-line @typescript-eslint/naming-convention
        Accept: "*/*",
        // eslint-disable-next-line @typescript-eslint/naming-convention
        "Accept-Encoding": "gzip, deflate, br",
      },
    };

    get(downloadUrl, requestOptions, response => {
      const code = response.statusCode ?? 404;

      if (code >= 400) {
        //return reject(new Error(response.statusMessage));
        Logger.log(
          "Error while downloading toolchain: " + response.statusMessage
        );

        return resolve(false);
      }

      // handle redirects
      if (code > 300 && code < 400 && !!response.headers.location) {
        return resolve(
          downloadAndInstallToolchain(toolchain, response.headers.location)
        );
      }

      // save the file to disk
      const fileWriter = createWriteStream(archiveFilePath).on("finish", () => {
        // unpack the archive
        if (artifactExt === "tar.xz" || artifactExt === "tar.gz") {
          unxzFile(archiveFilePath, targetDirectory)
            .then(success => {
              // delete tmp file
              unlinkSync(archiveFilePath);
              resolve(success);
            })
            .catch(() => {
              unlinkSync(archiveFilePath);
              unlinkSync(targetDirectory);
              resolve(false);
            });
        } else if (artifactExt === "zip") {
          const success = unzipFile(archiveFilePath, targetDirectory);
          // delete tmp file
          unlinkSync(archiveFilePath);
          if (!success) {
            unlinkSync(targetDirectory);
          }
          resolve(success);
        } else {
          unlinkSync(archiveFilePath);
          unlinkSync(targetDirectory);
          Logger.log(`Error: unknown archive extension: ${artifactExt}`);
          resolve(false);
        }
      });

      response.pipe(fileWriter);
    }).on("error", () => {
      // clean
      unlinkSync(archiveFilePath);
      unlinkSync(targetDirectory);
      Logger.log("Error while downloading toolchain.");

      return false;
    });
  });
}

export async function downloadAndInstallNinja(
  version: string,
  redirectURL?: string
): Promise<boolean> {
  /*if (process.platform === "linux") {
    Logger.log("Ninja installation on Linux is not supported.");

    return false;
  }*/

  const targetDirectory = buildNinjaPath(version);

  // Check if the SDK is already installed
  if (redirectURL === undefined && existsSync(targetDirectory)) {
    Logger.log(`Ninja ${version} is already installed.`);

    return true;
  }

  // Ensure the target directory exists
  await mkdir(targetDirectory, { recursive: true });

  const tmpBasePath = join(tmpdir(), "pico-sdk");
  await mkdir(tmpBasePath, { recursive: true });
  const archiveFilePath = join(tmpBasePath, `ninja.zip`);

  const octokit = new Octokit();
  // eslint-disable-next-line @typescript-eslint/naming-convention
  let ninjaAsset: { name: string; browser_download_url: string } | undefined;

  try {
    if (redirectURL === undefined) {
      const releaseResponse = await octokit.rest.repos.getReleaseByTag({
        owner: "ninja-build",
        repo: "ninja",
        tag: version,
      });
      if (
        releaseResponse.status !== 200 &&
        releaseResponse.data === undefined
      ) {
        Logger.log(`Error fetching ninja release ${version}.`);

        return false;
      }
      const release = releaseResponse.data;
      const assetName = `ninja-${NINJA_PLATFORMS[process.platform]}.zip`;

      // Find the asset with the name 'ninja-win.zip'
      ninjaAsset = release.assets.find(asset => asset.name === assetName);
    } else {
      ninjaAsset = {
        name: version,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        browser_download_url: redirectURL,
      };
    }
  } catch (error) {
    Logger.log(
      `Error fetching ninja release ${version}. ${
        error instanceof Error ? error.message : (error as string)
      }`
    );

    return false;
  }

  if (!ninjaAsset) {
    Logger.log(`Error release asset for ninja release ${version} not found.`);

    return false;
  }

  // Download the asset
  const assetUrl = ninjaAsset.browser_download_url;

  return new Promise(resolve => {
    // Use https.get to download the asset
    get(assetUrl, response => {
      const code = response.statusCode ?? 404;

      // redirects not supported
      if (code >= 400) {
        //return reject(new Error(response.statusMessage));
        Logger.log("Error while downloading ninja: " + response.statusMessage);

        return resolve(false);
      }

      // handle redirects
      if (code > 300 && code < 400 && !!response.headers.location) {
        return resolve(
          downloadAndInstallNinja(version, response.headers.location)
        );
      }

      // save the file to disk
      const fileWriter = createWriteStream(archiveFilePath).on("finish", () => {
        // unpack the archive
        const success = unzipFile(archiveFilePath, targetDirectory);

        // delete tmp file
        unlinkSync(archiveFilePath);

        // unzipper would require custom permission handling as it
        // doesn't preserve the executable flag
        /*if (process.platform !== "win32") {
          chmodSync(join(targetDirectory, "ninja"), 0o755);
        }*/

        resolve(success);
      });

      response.pipe(fileWriter);
    }).on("error", error => {
      Logger.log("Error downloading asset:" + error.message);
      resolve(false);
    });
  });
}

export async function downloadAndInstallOpenOCD(
  version: string,
  redirectURL?: string
): Promise<boolean> {
  if (process.platform !== "win32") {
    Logger.log("OpenOCD installation not on Windows is not supported.");

    return false;
  }

  const targetDirectory = buildOpenOCDPath(version);

  // Check if the SDK is already installed
  if (redirectURL === undefined && existsSync(targetDirectory)) {
    Logger.log(`OpenOCD ${version} is already installed.`);

    return true;
  }

  // Ensure the target directory exists
  await mkdir(targetDirectory, { recursive: true });

  const tmpBasePath = join(tmpdir(), "pico-sdk");
  await mkdir(tmpBasePath, { recursive: true });
  const archiveFilePath = join(tmpBasePath, `openocd.zip`);

  const octokit = new Octokit();
  // eslint-disable-next-line @typescript-eslint/naming-convention
  let openocdAsset: { name: string; browser_download_url: string } | undefined;

  try {
    if (redirectURL === undefined) {
      const releaseResponse = await octokit.rest.repos.getReleaseByTag({
        owner: "raspberrypi",
        repo: "pico-setup-windows",
        tag: version,
      });
      if (
        releaseResponse.status !== 200 &&
        releaseResponse.data === undefined
      ) {
        Logger.log(`Error fetching OpenOCD release ${version}.`);

        return false;
      }
      const release = releaseResponse.data;
      const assetName = `openocd-${OPENOCD_PLATFORMS[process.platform]}.zip`;

      // Find the asset with the name 'ninja-win.zip'
      Logger.log(release.assets_url);
      openocdAsset = release.assets.find(asset => asset.name === assetName);
    } else {
      openocdAsset = {
        name: version,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        browser_download_url: redirectURL,
      };
    }
  } catch (error) {
    Logger.log(
      `Error fetching OpenOCD release ${version}. ${
        error instanceof Error ? error.message : (error as string)
      }`
    );

    return false;
  }

  if (!openocdAsset) {
    Logger.log(`Error release asset for OpenOCD release ${version} not found.`);

    return false;
  }

  // Download the asset
  const assetUrl = openocdAsset.browser_download_url;

  return new Promise(resolve => {
    // Use https.get to download the asset
    get(assetUrl, response => {
      const code = response.statusCode ?? 404;

      // redirects not supported
      if (code >= 400) {
        //return reject(new Error(response.statusMessage));
        Logger.log("Error downloading OpenOCD: " + response.statusMessage);

        return resolve(false);
      }

      // handle redirects
      if (code > 300 && code < 400 && !!response.headers.location) {
        return resolve(
          downloadAndInstallOpenOCD(version, response.headers.location)
        );
      }

      // save the file to disk
      const fileWriter = createWriteStream(archiveFilePath).on("finish", () => {
        // unpack the archive
        const success = unzipFile(archiveFilePath, targetDirectory, false);

        // delete tmp file
        // unlinkSync(archiveFilePath);

        // unzipper would require custom permission handling as it
        // doesn't preserve the executable flag
        /*if (process.platform !== "win32") {
          chmodSync(join(targetDirectory, "ninja"), 0o755);
        }*/

        resolve(success);
      });

      response.pipe(fileWriter);
    }).on("error", error => {
      Logger.log("Error downloading asset:" + error.message);
      resolve(false);
    });
  });
}

/**
 * Supports Windows and macOS amd64 and arm64.
 *
 * @param version
 * @returns
 */
export async function downloadAndInstallCmake(
  version: string,
  redirectURL?: string
): Promise<boolean> {
  /*if (process.platform === "linux") {
    Logger.log("CMake installation on Linux is not supported.");

    return false;
  }*/

  const targetDirectory = buildCMakePath(version);

  // Check if the SDK is already installed
  if (redirectURL === undefined && existsSync(targetDirectory)) {
    Logger.log(`CMake ${version} is already installed.`);

    return true;
  }

  // Ensure the target directory exists
  await mkdir(targetDirectory, { recursive: true });
  const assetExt = process.platform === "win32" ? "zip" : "tar.gz";

  const tmpBasePath = join(tmpdir(), "pico-sdk");
  await mkdir(tmpBasePath, { recursive: true });
  const archiveFilePath = join(tmpBasePath, `cmake-${version}.${assetExt}`);

  const octokit = new Octokit();

  // eslint-disable-next-line @typescript-eslint/naming-convention
  let cmakeAsset: { name: string; browser_download_url: string } | undefined;

  try {
    if (redirectURL === undefined) {
      const releaseResponse = await octokit.rest.repos.getReleaseByTag({
        owner: "Kitware",
        repo: "CMake",
        tag: version,
      });
      if (
        releaseResponse.status !== 200 &&
        releaseResponse.data === undefined
      ) {
        Logger.log(`Error fetching CMake release ${version}.`);

        return false;
      }
      const release = releaseResponse.data;
      const assetName = `cmake-${version.replace("v", "")}-${
        CMAKE_PLATFORMS[process.platform]
      }-${
        process.platform === "darwin"
          ? "universal"
          : process.arch === "arm64"
          ? process.platform === "linux"
            ? "aarch64"
            : "arm64"
          : "x86_64"
      }.${assetExt}`;

      cmakeAsset = release.assets.find(asset => asset.name === assetName);
    } else {
      cmakeAsset = {
        name: version,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        browser_download_url: redirectURL,
      };
    }
  } catch (error) {
    Logger.log(
      `Error fetching CMake release ${version}. ${
        error instanceof Error ? error.message : (error as string)
      }`
    );

    return false;
  }

  if (!cmakeAsset) {
    Logger.log(`Error release asset for cmake release ${version} not found.`);

    return false;
  }

  // Download the asset
  const assetUrl = cmakeAsset.browser_download_url;

  return new Promise(resolve => {
    // Use https.get to download the asset
    get(assetUrl, response => {
      const code = response.statusCode ?? 0;

      // redirects not supported
      if (code >= 400) {
        //return reject(new Error(response.statusMessage));
        Logger.log(
          "Error while downloading toolchain: " + response.statusMessage
        );

        return resolve(false);
      }

      // handle redirects
      if (code > 300 && code < 400 && !!response.headers.location) {
        return resolve(
          downloadAndInstallCmake(version, response.headers.location)
        );
      }

      // save the file to disk
      const fileWriter = createWriteStream(archiveFilePath).on("finish", () => {
        // unpack the archive
        if (process.platform === "darwin" || process.platform === "linux") {
          unxzFile(archiveFilePath, targetDirectory)
            .then(success => {
              // delete tmp file
              unlinkSync(archiveFilePath);
              // macOS
              //chmodSync(join(targetDirectory, "CMake.app", "Contents", "bin", "cmake"), 0o755);
              resolve(success);
            })
            .catch(() => {
              unlinkSync(archiveFilePath);
              unlinkSync(targetDirectory);
              resolve(false);
            });
        } else if (process.platform === "win32") {
          const success = unzipFile(archiveFilePath, targetDirectory);
          // delete tmp file
          unlinkSync(archiveFilePath);
          resolve(success);
        } else {
          Logger.log(`Error: platform not supported for downloading cmake.`);
          unlinkSync(archiveFilePath);
          unlinkSync(targetDirectory);

          resolve(false);
        }
      });

      response.pipe(fileWriter);
    }).on("error", error => {
      Logger.log("Error downloading asset: " + error.message);
      resolve(false);
    });
  });
}

/**
 * Only supported Windows amd64 and arm64.
 *
 * @returns
 */
export async function downloadEmbedPython(
  versionBundle: VersionBundle,
  redirectURL?: string
): Promise<string | undefined> {
  if (
    // even tough this function supports downloading python3 on macOS arm64
    // it doesn't work correctly therefore it's excluded here
    // use pyenvInstallPython instead
    process.platform !== "win32" ||
    (process.platform === "win32" && process.arch !== "x64")
  ) {
    Logger.log(
      "Embed Python installation on Windows x64 and macOS arm64 only."
    );

    return;
  }

  const targetDirectory = buildPython3Path(versionBundle.python.version);
  const settingsTargetDirectory =
    `${HOME_VAR}/.pico-sdk` + `/python/${versionBundle.python.version}`;

  // Check if the Embed Python is already installed
  if (redirectURL === undefined && existsSync(targetDirectory)) {
    Logger.log(`Embed Python is already installed correctly.`);

    return `${settingsTargetDirectory}/python.exe`;
  }

  // Ensure the target directory exists
  await mkdir(targetDirectory, { recursive: true });

  // select download url
  const downloadUrl = versionBundle.python.windowsAmd64;

  const tmpBasePath = join(tmpdir(), "pico-sdk");
  await mkdir(tmpBasePath, { recursive: true });
  const archiveFilePath = join(
    tmpBasePath,
    `python-${versionBundle.python.version}.zip`
  );

  return new Promise(resolve => {
    const requestOptions = {
      headers: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        "User-Agent": "VSCode-RaspberryPi-Pico-Extension",
        // eslint-disable-next-line @typescript-eslint/naming-convention
        Accept: "*/*",
        // eslint-disable-next-line @typescript-eslint/naming-convention
        "Accept-Encoding": "gzip, deflate, br",
      },
    };

    get(downloadUrl, requestOptions, response => {
      const code = response.statusCode ?? 0;

      if (code >= 400) {
        //return reject(new Error(response.statusMessage));
        Logger.log("Error while downloading python: " + response.statusMessage);

        return resolve(undefined);
      }

      // handle redirects
      if (code > 300 && code < 400 && !!response.headers.location) {
        return resolve(
          downloadEmbedPython(versionBundle, response.headers.location)
        );
      }

      // save the file to disk
      const fileWriter = createWriteStream(archiveFilePath).on("finish", () => {
        // doesn't work correctly therefore use pyenvInstallPython instead
        // TODO: remove unused darwin code-path here
        if (process.platform === "darwin") {
          const pkgExtractor = new MacOSPythonPkgExtractor(
            archiveFilePath,
            targetDirectory
          );

          pkgExtractor
            .extractPkg()
            .then(success => {
              if (versionBundle.python.version.lastIndexOf(".") <= 2) {
                Logger.log(
                  "Error while extracting Python: " +
                    "Python version has wrong format."
                );
                resolve(undefined);
              }

              if (success) {
                try {
                  // create symlink, so the same path can be used as on Windows
                  const srcPath = joinPosix(
                    settingsTargetDirectory,
                    "/Versions/",
                    versionBundle.python.version.substring(
                      0,
                      versionBundle.python.version.lastIndexOf(".")
                    ),
                    "bin",
                    "python3"
                  );
                  symlinkSync(
                    srcPath,
                    // use .exe as python is already used in the directory
                    join(settingsTargetDirectory, "python.exe"),
                    "file"
                  );
                  symlinkSync(
                    srcPath,
                    // use .exe as python is already used in the directory
                    join(settingsTargetDirectory, "python3.exe"),
                    "file"
                  );
                } catch {
                  resolve(undefined);
                }

                resolve(`${settingsTargetDirectory}/python.exe`);
              } else {
                resolve(undefined);
              }
            })
            .catch(() => {
              resolve(undefined);
            });
        } else {
          // unpack the archive
          const success = unzipFile(archiveFilePath, targetDirectory);
          // delete tmp file
          unlinkSync(archiveFilePath);
          resolve(
            success ? `${settingsTargetDirectory}/python.exe` : undefined
          );
        }
      });

      response.pipe(fileWriter);
    }).on("error", () => {
      Logger.log("Error while downloading Embed Python.");

      return false;
    });
  });
}

const GIT_DOWNLOAD_URL_WIN_AMD64 =
  "https://github.com/git-for-windows/git/releases/download" +
  "/v2.43.0.windows.1/MinGit-2.43.0-64-bit.zip";
const GIT_MACOS_VERSION = "2.43.0";
const GIT_DOWNLOAD_URL_MACOS_ARM64 =
  "https://bd752571.vscode-raspberry-pi-pico.pages.dev" +
  "/git-2.43.0-arm64_sonoma.bottle.tar.gz";
const GIT_DOWNLOAD_URL_MACOS_INTEL =
  "https://bd752571.vscode-raspberry-pi-pico.pages.dev" +
  "/git-2.43.0-intel_sonoma.bottle.tar.gz";

/**
 * Only supported Windows amd64 and macOS arm64 and amd64.
 *
 * @returns
 */
export async function downloadGit(
  redirectURL?: string
): Promise<string | undefined> {
  if (
    process.platform !== "win32" ||
    (process.platform === "win32" && process.arch !== "x64")
  ) {
    Logger.log("Git installation on Windows x64 and macOS only.");

    return;
  }

  const targetDirectory = join(homedir(), ".pico-sdk", "git");
  const settingsTargetDirectory = `${HOME_VAR}/.pico-sdk/git`;

  // Check if the Embed Python is already installed
  if (redirectURL === undefined && existsSync(targetDirectory)) {
    Logger.log(`Git is already installed.`);

    return process.platform === "win32"
      ? `${settingsTargetDirectory}/cmd/git.exe`
      : `${settingsTargetDirectory}/bin/git`;
  }

  // Ensure the target directory exists
  await mkdir(targetDirectory, { recursive: true });

  // select download url for platform()_arch()
  const downloadUrl = redirectURL ?? GIT_DOWNLOAD_URL_WIN_AMD64;

  const tmpBasePath = join(tmpdir(), "pico-sdk");
  await mkdir(tmpBasePath, { recursive: true });
  const archiveFilePath = join(tmpBasePath, `git.zip`);

  return new Promise(resolve => {
    const requestOptions = {
      headers: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        "User-Agent": "VSCode-RaspberryPi-Pico-Extension",
        // eslint-disable-next-line @typescript-eslint/naming-convention
        Accept: "*/*",
        // eslint-disable-next-line @typescript-eslint/naming-convention
        "Accept-Encoding": "gzip, deflate, br",
      },
    };

    get(downloadUrl, requestOptions, response => {
      const code = response.statusCode ?? 0;

      if (code >= 400) {
        //return reject(new Error(response.statusMessage));
        Logger.log("Error while downloading git: " + response.statusMessage);

        resolve(undefined);
      }

      // handle redirects
      if (code > 300 && code < 400 && !!response.headers.location) {
        return resolve(downloadGit(response.headers.location));
      }

      // save the file to disk
      const fileWriter = createWriteStream(archiveFilePath).on("finish", () => {
        // TODO: remove unused code-path here
        if (process.platform === "darwin") {
          unxzFile(archiveFilePath, targetDirectory)
            .then(success => {
              unlinkSync(archiveFilePath);
              resolve(
                success ? `${settingsTargetDirectory}/bin/git` : undefined
              );
            })
            .catch(() => {
              resolve(undefined);
            });
        } else {
          // unpack the archive
          const success = unzipFile(archiveFilePath, targetDirectory);
          // delete tmp file
          unlinkSync(archiveFilePath);

          if (success) {
            // remove include section from gitconfig included in MiniGit
            // which hardcodes the a path in Programm Files to be used by this git executable
            exec(
              `${
                process.env.ComSpec === "powershell.exe" ? "&" : ""
              }"${targetDirectory}/cmd/git.exe" config ` +
                `--file "${targetDirectory}/etc/gitconfig" ` +
                "--remove-section include",
              error => {
                if (error) {
                  Logger.log(
                    `Error executing git: ${
                      error instanceof Error ? error.message : (error as string)
                    }`
                  );
                  resolve(undefined);
                } else {
                  resolve(`${settingsTargetDirectory}/cmd/git.exe`);
                }
              }
            );
          } else {
            resolve(undefined);
          }
        }
      });

      response.pipe(fileWriter);
    }).on("error", () => {
      Logger.log("Error while downloading git.");

      return false;
    });
  });
}
