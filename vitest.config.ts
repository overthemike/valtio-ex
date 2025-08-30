import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "bench",
		environment: "node",
		globals: true,
	},
});

