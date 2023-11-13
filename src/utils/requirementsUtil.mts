import { window } from "vscode";
import which from "which";
import type Settings from "../settings.mjs";
import { SettingsKey } from "../settings.mjs";

/**
 * Checks if all requirements are met (to run the Pico Project Generator and cmake generator)
 *
 * @returns true if all requirements are met, false otherwise
 */
export async function checkForRequirements(
  settings: Settings
): Promise<[boolean, string[]]> {
  const ninjaExe: string = settings.getString(SettingsKey.ninjaPath) || "ninja";
  const cmakeExe: string = settings.getString(SettingsKey.cmakePath) || "cmake";
  const python3Exe: string =
    settings.getString(SettingsKey.python3Path) || process.platform === "win32"
      ? "python"
      : "python3";

  const ninja: string | null = await which(ninjaExe, { nothrow: true });
  const cmake: string | null = await which(cmakeExe, { nothrow: true });
  const python3: string | null = await which(python3Exe, { nothrow: true });

  const missing: string[] = [];
  if (ninja === null) {
    missing.push("Ninja");
  }
  if (cmake === null) {
    missing.push("CMake");
  }
  if (python3 === null) {
    missing.push("Python 3");
  }

  // TODO: check python version
  return [missing.length === 0, missing];
}

export async function showRequirementsNotMetErrorMessage(
  missing: string[]
): Promise<void> {
  await window.showErrorMessage(
    "Development for the Pico (W) requires " +
      missing.join(", ") +
      " to be installed and available in the PATH. " +
      "Please install and restart VS Code."
  );
}

/**
 * Checks if all requirements for installing a Pico-SDK are met
 * TODO: add support for custom compiler and git paths in settings
 *
 * @returns true if all requirements are met, false otherwise
 */
export async function checkForInstallationRequirements(): Promise<boolean> {
  const gitExe: string = "git";
  const compilerExe: string[] = ["clang", "gcc", "cl"];
  const tools: string[] = ["pioasm", "elf2uf2"];

  const git: string | null = await which(gitExe, { nothrow: true });
  //check if any of the compilers is available
  const compiler: string | null = await Promise.any(
    compilerExe
      .map(compiler => which(compiler, { nothrow: true }))
      .map(p => p.catch(() => null))
  );
  // check for avialbility of tools
  let allToolsAvailable: boolean = true;
  for (const tool of tools) {
    const toolPath: string | null = await which(tool, { nothrow: true });
    if (toolPath === null) {
      allToolsAvailable = false;
      break;
    }
  }

  let requirementsMet: boolean = true;
  if (git === null) {
    requirementsMet = false;
  }
  if (!allToolsAvailable) {
    // only check for compilers if pioasm
    if (compiler === null) {
      requirementsMet = false;
    }
  }

  if (!requirementsMet) {
    void showInstallationRequirementsNotMetErrorMessage(
      git !== null,
      allToolsAvailable || compiler !== null
    );
  }

  return requirementsMet;
}

export async function showInstallationRequirementsNotMetErrorMessage(
  isGitInstalled: boolean,
  allToolsAvailableOrCompilerInstalled: boolean
): Promise<void> {
  if (!isGitInstalled) {
    await window.showErrorMessage(
      "Installation of the Pico-SDK requires Git " +
        "to be installed and available in the PATH."
    );
  }
  if (!allToolsAvailableOrCompilerInstalled) {
    await window.showErrorMessage(
      "Either pioasm and elf2uf2 need to be installed and in PATH or " +
        "a native C/C++ compiler (clang or gcc) needs to be installed and in " +
        "PATH for manuall compilation of the tools." +
        "Please install and restart VS Code."
    );
  }
}
