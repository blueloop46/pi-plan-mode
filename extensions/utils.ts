/** Accept a small shell subset, not arbitrary scripts or interpreters. */
export function isHarmlessCommand(value: unknown): boolean {
	if (typeof value !== "string" || /[`$\\|<>(){}\r\0]/.test(value)) return false;
	const commands: string[][] = [[]];
	let word = "";
	let started = false;
	let quote = "";
	const finishWord = () => {
		if (started) commands[commands.length - 1].push(word);
		word = "";
		started = false;
	};
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (quote) {
			if (char === quote) quote = "";
			else word += char;
		} else if (char === '"' || char === "'") {
			quote = char;
			started = true;
		} else if (char === ";" || char === "\n" || char === "&") {
			if (char === "&" && value[++i] !== "&") return false;
			finishWord();
			if (!commands[commands.length - 1].length) return false;
			commands.push([]);
		} else if (/\s/.test(char)) {
			finishWord();
		} else {
			// Unquoted globs can expand filenames into executable command options.
			if (/[#*?\[\]~]/.test(char)) return false;
			word += char;
			started = true;
		}
	}
	if (quote) return false;
	finishWord();
	return commands.every(isReadOnly);
}

function isReadOnly([command, ...args]: string[]): boolean {
	if (!command) return false;
	if (["cat", "head", "tail"].includes(command)) {
		// Require at least one non-flag argument (bare cat/head/tail read stdin — block them).
		if (!args.some((arg) => !arg.startsWith("-"))) return false;
		// tail -f / --follow / combined short flags containing f (e.g. -fn) hang indefinitely.
		if (command === "tail" && args.some((arg) => arg === "-f" || arg === "--follow" || (/^-[^-]/.test(arg) && arg.includes("f")))) return false;
		return true;
	}
	if (["ls", "pwd", "grep", "wc", "du", "df", "stat"].includes(command)) return true;
	if (command === "find") return !args.some((arg) => /^-(?:delete|exec|ok|fprint|fls)/.test(arg));
	if (command === "rg") return !args.some((arg) => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg));
	if (command === "fd") return !args.some((arg) => /^--exec|^-[^-]*[xX]/.test(arg));
	if (command === "file") return !args.some((arg) => /^-[^-]*C/.test(arg) || (arg.startsWith("--") && arg !== "--" && "--compile".startsWith(arg.split("=", 1)[0])));
	if (command === "git") {
		const [subcommand, ...options] = args;
		if (subcommand === "branch") return options.every((arg) => ["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--list", "--show-current"].includes(arg));
		if (subcommand === "remote") return !options.length || (options.length === 1 && ["-v", "--verbose"].includes(options[0]));
		return ["status", "log", "diff", "show"].includes(subcommand) && !options.some((arg) => {
			const option = arg.split("=", 1)[0];
			return option.startsWith("--") && option !== "--" && ["--output", "--ext-diff", "--textconv"].some((unsafe) => unsafe.startsWith(option));
		});
	}
	if (command === "printenv") return args.length > 0 && args.every((arg) => /^[A-Z_][A-Z0-9_]*$/.test(arg));
	if (command === "unzip") return args.length === 3 && args[0] === "-p" && !args[1].startsWith("-") && args[2] === "word/document.xml";
	if (command === "pdftotext") return args.length === 2 && !args[0].startsWith("-") && args[1] === "-";
	// Tests and build scripts execute arbitrary code and can change repository files.
	return false;
}
