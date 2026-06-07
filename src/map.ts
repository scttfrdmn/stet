import { type BurstOptions, Executor } from "./executor.js";

export async function map<T, U>(
	items: T[],
	fn: (item: T) => Promise<U> | U,
	options?: BurstOptions,
): Promise<U[]> {
	const executor = new Executor(options);
	try {
		return await executor.map(fn, items);
	} finally {
		await executor.shutdown();
	}
}

export async function mapTolerant<T, U>(
	items: T[],
	fn: (item: T) => Promise<U> | U,
	options?: BurstOptions,
): Promise<(U | null)[]> {
	const executor = new Executor(options);
	try {
		return await executor.mapTolerant(fn, items);
	} finally {
		await executor.shutdown();
	}
}
