import { Shell } from "@oh-my-pi/pi-natives";

/** Exercise the bundled native comparator, including its repeated-call and explicit-key contracts. */
export async function smokeTestNativeSort(): Promise<{ localeCollation: boolean }> {
	// Session-scoped values leave the caller's process and selected locale alone.
	const shell = new Shell({ sessionEnv: { LANG: "en_US.UTF-8", LC_ALL: "", LC_COLLATE: "" } });
	const run = async (command: string): Promise<string> => {
		let output = "";
		let streamError: Error | undefined;
		const result = await shell.run({ command, timeoutMs: 10_000 }, (error, chunk) => {
			if (error) streamError = error;
			output += chunk;
		});
		if (streamError) throw streamError;
		if (result.exitCode !== 0 || result.cancelled || result.timedOut) {
			throw new Error(`native sort smoke failed: command did not complete: ${output}`);
		}
		return output.replaceAll("\r\n", "\n");
	};
	const expectLines = async (label: string, command: string, expected: readonly string[], ordered = false) => {
		const output = await run(command);
		const lines = output.trimEnd().split("\n");
		const actual = ordered ? lines : lines.toSorted();
		const wanted = ordered ? [...expected] : expected.toSorted();
		if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
			throw new Error(
				`native sort smoke failed (${label}): expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`,
			);
		}
	};
	try {
		const paths = ["src/a-b.ts", "src/ab.ts", "src/a_b.ts", "src/a.b.ts"];
		const input = "printf '%s\\n' src/a-b.ts src/ab.ts src/a_b.ts src/a.b.ts src/a-b.ts";
		for (let call = 0; call < 2; call++) {
			await expectLines(`punctuation, call ${call + 1}`, `${input} | sort -u`, paths);
			await expectLines(`explicit key, call ${call + 1}`, `${input} | sort -k1,1 -u`, paths);
		}
		await expectLines("same selected key", "printf '%s\\n' 'key first' 'key second' 'other third' | sort -k1,1 -u", [
			"key first",
			"other third",
		]);
		await expectLines("dictionary equivalence", "printf '%s\\n' a-b a_b a.b ab | sort -d -u", ["a-b"]);
		await expectLines("case equivalence", "printf '%s\\n' Alpha alpha | sort -f -u", ["Alpha"]);
		await expectLines(
			"numeric equivalence",
			"printf '%s\\n' '2 first' '2 second' '10 third' | sort -n -u",
			["2 first", "10 third"],
			true,
		);
		await expectLines(
			"stable selected key",
			"printf '%s\\n' 'key z' 'key a' 'key m' | sort -s -k1,1",
			["key z", "key a", "key m"],
			true,
		);
		await expectLines("C override", `${input} | LC_ALL=C sort -u`, paths);
		await expectLines("locale after C override", `${input} | sort -u`, paths);
		const diagnostic = await run("printf '%s\\n' probe | sort --debug");
		const localeCollation = diagnostic.includes("text ordering performed using ‘en_US.UTF-8’ sorting rules");
		return { localeCollation };
	} finally {
		await shell.abort();
	}
}
