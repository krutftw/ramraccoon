from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills" / "ramraccoon" / "SKILL.md"
OPENAI_YAML = ROOT / "skills" / "ramraccoon" / "agents" / "openai.yaml"
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
require('brand_color: "#B8FF3D"' in openai_text, "brand color is missing")

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

print("RAM Raccoon skill contract: OK")
