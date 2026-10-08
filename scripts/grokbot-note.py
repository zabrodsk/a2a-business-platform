#!/usr/bin/env python3
"""Save a paste-ready Grok Bot message to Apple Notes (folder "Grok Bot – Business").

Usage: scripts/grokbot-note.py <prompt-file.md> "<note title>"

Takes the text between the first two lines that are exactly '---' in the prompt file
(the part meant to be pasted into the bot) and creates a plain-text note from it.
"""
import html
import subprocess
import sys

FOLDER = "Grok Bot – Business"

APPLESCRIPT = """
on run argv
  set folderName to item 1 of argv
  set noteTitle to item 2 of argv
  set noteBody to item 3 of argv
  tell application "Notes"
    if not (exists folder folderName) then make new folder with properties {name:folderName}
    make new note at folder folderName with properties {name:noteTitle, body:noteBody}
  end tell
end run
"""


def paste_section(path: str) -> str:
    lines = open(path, encoding="utf-8").read().splitlines()
    marks = [i for i, line in enumerate(lines) if line.strip() == "---"]
    if len(marks) < 2:
        sys.exit(f"{path}: expected the paste section between two '---' lines")
    return "\n".join(lines[marks[0] + 1 : marks[1]]).strip()


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    path, title = sys.argv[1], sys.argv[2]
    text = paste_section(path)
    # Notes bodies are HTML: title line, then one <div> per line so copy-paste keeps line breaks.
    body = f"<h1>{html.escape(title)}</h1>" + "".join(
        f"<div>{html.escape(line) or '<br>'}</div>" for line in text.splitlines()
    )
    subprocess.run(["osascript", "-e", APPLESCRIPT, FOLDER, title, body], check=True)
    print(f'Saved to Apple Notes › {FOLDER} › "{title}"')


if __name__ == "__main__":
    main()
