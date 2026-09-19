// Shared Jev boundary vocabulary. Preserve the union of the former row/grader
// ID grammars (alphanumeric/underscore IDs containing a digit), plus the
// canonical hyphenated architecture and interaction IDs: L0-01 and IX-1.
export function findingId(text) {
	const token = text.trimStart().match(/^([A-Za-z][\w-]*)(?=\s|$|,)/)?.[1];
	return token && /\d/.test(token) ? token : null;
}

export function requireProbability(value) {
	const message = "malformed Jev response: expected probability in [0, 1]";
	if (!Number.isFinite(value)) throw new Error(message);
	if (value < 0 || value > 1) throw new Error(message);
	return value;
}
