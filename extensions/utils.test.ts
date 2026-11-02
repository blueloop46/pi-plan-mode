import assert from "node:assert/strict";
import { isHarmlessCommand } from "./utils.ts";

const allowed = [
	"git status --short", "rg TODO src", "ls -la", "git branch -a", "git branch --show-current", "git remote -v",
	"pwd; git status --short; ls -la", "find src -type f; find tests -type f", "ls && git diff", "pwd\nls",
	"find . -name '*.md'", "find 'directory with spaces' -type f", "rg 'a;b && c' src", "rg '^x' src",
	"unzip -p 'file with spaces.docx' word/document.xml", "pdftotext file.pdf -", "printenv PI_CODING_AGENT_DIR",
	"git log -5 --oneline", "git show HEAD:README.md", "file example.docx", "fd -e md",
	// cat/head/tail with file arguments are allowed
	"cat somefile", "head -5 somefile", "tail -20 somefile", "tail -n 10 log.txt", "cat README.md",
];
const blocked = [
	"", "   ", "git diff > patch", "git commit -m nope", "rg TODO; rm -rf .", "ls && rm file", "ls || rm file",
	"find . -delete", "find . -exec rm file +", "find . -execdir rm file +", "find . -ok rm file +",
	"find . -fprint output", "find . -fprintf output format", "find . -fls output", "find . -'delete'",
	"git branch -D example", "git branch new-branch", "git remote remove origin", "git remote add origin url",
	"git log --output=log.txt", "git diff --output patch", "git diff --out=patch", "git diff --ext-diff", "git diff --ext", "git show --textconv",
	"rg --pre script pattern", "rg --pre=script pattern", "rg --hostname-bin=script pattern",
	"fd -x rm", "fd -Haxrm", "fd --exec=rm", "fd --exec-batch rm", "file -C", "file -Cm magic", "file --compile", "file --comp", "file --com=magic",
	"npm test", "npm run lint", "pytest", "make test", "python3 inspect.py", "printenv",
	"ls | head", "ls $(touch file)", "ls `touch file`", "ls &", "ls &&", "ls;", "ls # comment",
	"find . *", "rg x [a-z]", "ls 'unterminated", "ls\\\nrm file", "ls\r\nrm file", "ls\0",
	"unzip file.docx", "unzip -p file.docx word/document.xml; rm file", "pdftotext file.pdf output.txt",
	// bare cat/head/tail (stdin reads) are blocked
	"cat", "cat -", "head", "tail",
	// tail -f / --follow / combined flags with f hang indefinitely
	"tail -f somefile", "tail -fn 5 somefile", "tail --follow somefile",
];
for (const command of allowed) assert.equal(isHarmlessCommand(command), true, command);
for (const command of blocked) assert.equal(isHarmlessCommand(command), false, command);
for (const value of [null, undefined, 0, {}]) assert.equal(isHarmlessCommand(value), false);
console.log(`Shell policy: ${allowed.length + blocked.length + 4} assertions passed.`);
