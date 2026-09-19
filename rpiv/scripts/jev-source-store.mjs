// Source-level persistence for eval linting. Completed batches are independent
// of rotating diagnostic logs. An exclusive reservation covers the asynchronous
// model calls; atomic rename publishes the entire successful batch at once.
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const contentDigest = (text) =>
	createHash("sha256").update(text).digest("hex");

function sourceKey(source) {
	const path = resolve(source).replaceAll("\\", "/");
	return contentDigest(
		process.platform === "win32" ? path.toLowerCase() : path,
	);
}

function pathsFor(logPath, source) {
	const dir = `${resolve(logPath)}.sources`;
	const key = sourceKey(source);
	return {
		dir,
		batch: join(dir, `${key}.json`),
		lock: join(dir, `${key}.lock`),
	};
}

export function readCompletedBatch(logPath, source) {
	const { batch } = pathsFor(logPath, source);
	if (!existsSync(batch)) return null;
	return readBatchFile(batch);
}

function readBatchFile(batch) {
	const data = JSON.parse(readFileSync(batch, "utf8"));
	if (data.status !== "complete" || !Array.isArray(data.results))
		throw new Error(`broken source batch: ${batch}`);
	return data;
}

export function readCommittedRows(logPath) {
	const dir = `${resolve(logPath)}.sources`;
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.flatMap((name) => readBatchFile(join(dir, name)).results);
}

export function writeCompletedBatch(logPath, source, batch) {
	const paths = pathsFor(logPath, source);
	mkdirSync(paths.dir, { recursive: true });
	const temp = `${paths.batch}.${randomUUID()}.tmp`;
	try {
		writeSynced(temp, batch);
		renameSync(temp, paths.batch);
	} finally {
		if (existsSync(temp)) unlinkSync(temp);
	}
}

function writeSynced(path, batch) {
	const fd = openSync(path, "wx");
	try {
		writeFileSync(fd, JSON.stringify(batch), "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code !== "ESRCH";
	}
}

// Only one contender can unlink a dead owner's unique token. A loser never
// removes the directory, so it cannot delete a new owner's reservation.
function reclaimDeadOwner(lock) {
	let entries;
	try {
		entries = readdirSync(lock);
	} catch (error) {
		if (error.code === "ENOENT") return true;
		throw error;
	}
	if (entries.length === 0) return removeEmptyLock(lock);
	const { owner, pid } = reservationOwner(entries, lock);
	if (processAlive(pid)) return false;
	try {
		unlinkSync(join(lock, owner));
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
	return removeEmptyLock(lock);
}

function removeEmptyLock(lock) {
	try {
		rmdirSync(lock);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return true;
		if (error.code === "ENOTEMPTY" || error.code === "EEXIST") return false;
		throw error;
	}
}

function reservationOwner(entries, lock) {
	if (entries.length !== 1)
		throw new Error(`incomplete source reservation: ${lock}`);
	const owner = entries[0];
	const pid = Number(owner.split("-")[0]);
	if (!Number.isInteger(pid) || pid <= 0)
		throw new Error(`invalid source reservation: ${lock}`);
	return { owner, pid };
}

export function reserveSource(logPath, source) {
	const { dir, lock } = pathsFor(logPath, source);
	mkdirSync(dir, { recursive: true });
	if (existsSync(lock) && !reclaimDeadOwner(lock)) return null;
	const token = `${process.pid}-${randomUUID()}.json`;
	if (!publishReservation(lock, token)) return null;
	return () => {
		unlinkSync(join(lock, token));
		removeEmptyLock(lock);
	};
}

// Publish owner + directory in one rename. No visible reservation can belong
// to a live worker while still waiting for its owner token to be written.
function publishReservation(lock, token) {
	const candidate = `${lock}.${randomUUID()}.candidate`;
	mkdirSync(candidate);
	try {
		writeFileSync(join(candidate, token), "{}", { flag: "wx" });
		try {
			renameSync(candidate, lock);
			return true;
		} catch (error) {
			if (
				["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code) &&
				existsSync(lock)
			)
				return false;
			throw error;
		}
	} finally {
		rmSync(candidate, { recursive: true, force: true });
	}
}
