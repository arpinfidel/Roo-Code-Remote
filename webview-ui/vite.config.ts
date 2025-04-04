import path from "path"
import fs from "fs"

import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [
		react(),
		tailwindcss(),
		{
			name: "copy-codicons-font",
			writeBundle() {
				const fontSrc = path.resolve(__dirname, "../node_modules/@vscode/codicons/dist/codicon.ttf")
				const fontDest = path.resolve(__dirname, "public/codicon.ttf")
				fs.copyFileSync(fontSrc, fontDest)
			},
		},
	],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	build: {
		outDir: "build",
		reportCompressedSize: false,
		rollupOptions: {
			output: {
				entryFileNames: `assets/[name].js`,
				chunkFileNames: `assets/[name].js`,
				assetFileNames: `assets/[name].[ext]`,
			},
		},
	},
	server: {
		hmr: {
			host: "localhost",
			protocol: "ws",
		},
		cors: {
			origin: "*",
			methods: "*",
			allowedHeaders: "*",
		},
		fs: {
			allow: [
				// Search for workspace root
				process.cwd(),
				// Allow serving files from codicons
				path.resolve(__dirname, "../node_modules/@vscode/codicons"),
			],
		},
	},
	define: {
		"process.platform": JSON.stringify(process.platform),
		"process.env.VSCODE_TEXTMATE_DEBUG": JSON.stringify(process.env.VSCODE_TEXTMATE_DEBUG),
	},
})
