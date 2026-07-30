from pathlib import Path
import json
import re


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills" / "ramraccoon" / "SKILL.md"
OPENAI_YAML = ROOT / "skills" / "ramraccoon" / "agents" / "openai.yaml"
README = ROOT / "README.md"
HERO = ROOT / "assets" / "ramraccoon-hero.svg"
MARK = ROOT / "skills" / "ramraccoon" / "assets" / "ramraccoon-mark.svg"
COMPARE = (
    ROOT
    / "skills"
    / "ramraccoon"
    / "scripts"
    / "Compare-RamRaccoonSnapshots.ps1"
)
END_TO_END = ROOT / "tests" / "Test-RamRaccoonEndToEnd.ps1"
EVIDENCE = ROOT / "evidence" / "windows-2026-07-30-before.json"
E2E_EVIDENCE = ROOT / "evidence" / "windows-2026-07-30-e2e.json"
SNAPSHOT = (
    ROOT
    / "skills"
    / "ramraccoon"
    / "scripts"
    / "Get-RamRaccoonSnapshot.ps1"
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


skill_text = SKILL.read_text(encoding="utf-8")
frontmatter_match = re.match(r"^---\n(.*?)\n---\n", skill_text, re.DOTALL)
require(frontmatter_match is not None, "SKILL.md needs YAML frontmatter")

frontmatter_lines = [
    line for line in frontmatter_match.group(1).splitlines() if line.strip()
]
keys = [line.split(":", 1)[0].strip() for line in frontmatter_lines]
require(keys == ["name", "description"], "frontmatter must contain only name and description")
require("name: ramraccoon" in frontmatter_match.group(1), "skill name must be ramraccoon")
require("[TODO" not in skill_text, "SKILL.md contains an unresolved TODO")
require(len(skill_text.splitlines()) < 500, "SKILL.md should stay below 500 lines")

openai_text = OPENAI_YAML.read_text(encoding="utf-8")
require('display_name: "RAM Raccoon"' in openai_text, "display name is missing")
require("$ramraccoon" in openai_text, "default prompt must mention $ramraccoon")
require('brand_color: "#E2552D"' in openai_text, "brand color is missing")

brand_text = "\n".join(
    path.read_text(encoding="utf-8") for path in (README, HERO, MARK, OPENAI_YAML)
)
require("#E2552D" in brand_text, "vermilion brand accent is missing")
require("#B8FF3D" not in brand_text.upper(), "retired lime brand color returned")

snapshot_text = SNAPSHOT.read_text(encoding="utf-8")
for forbidden in (
    "Stop-Process",
    "taskkill",
    ".Terminate(",
    "Win32_Process.Delete",
    "TerminateProcess",
):
    require(forbidden not in snapshot_text, f"read-only script contains {forbidden}")

require("CommandLinesEmitted = $false" in snapshot_text, "privacy contract is missing")
require("ProcessesTerminated = 0" in snapshot_text, "termination contract is missing")
require(COMPARE.is_file(), "before/after comparator is missing")
require(END_TO_END.is_file(), "end-to-end test is missing")
require(EVIDENCE.is_file(), "sanitized evidence snapshot is missing")
require(E2E_EVIDENCE.is_file(), "sanitized end-to-end evidence is missing")

for runtime_file in (SNAPSHOT, COMPARE):
    runtime_text = runtime_file.read_text(encoding="utf-8")
    for forbidden in (
        "Stop-Process",
        "taskkill",
        ".Terminate(",
        "Win32_Process.Delete",
        "TerminateProcess",
        "Invoke-WebRequest",
        "Invoke-RestMethod",
        "Start-Process",
        "Invoke-Expression",
    ):
        require(
            forbidden not in runtime_text,
            f"{runtime_file.name} contains forbidden operation {forbidden}",
        )

e2e_evidence_text = E2E_EVIDENCE.read_text(encoding="utf-8")
e2e_evidence = json.loads(e2e_evidence_text)
require(e2e_evidence["Result"] == "PASSED", "end-to-end evidence did not pass")
require(
    e2e_evidence["Runtime"]["ReportedProcessCount"]
    == e2e_evidence["Runtime"]["IndependentProcessCount"],
    "recorded independent process count does not match",
)
require(
    e2e_evidence["Assertions"]["ProcessesTerminated"] == 0,
    "recorded end-to-end run terminated a process",
)
for private_marker in ("C:\\Users", "Administrator", "SkillRoot", "AppServerPid"):
    require(
        private_marker not in e2e_evidence_text,
        f"end-to-end evidence contains private marker {private_marker}",
    )

print("RAM Raccoon skill contract: OK")
