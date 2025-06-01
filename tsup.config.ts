import {defineConfig} from 'tsup'

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'es2022',
    outDir: 'dist',
    clean: true,
    minify: false,
    splitting: false,
    sourcemap: false,
    dts: false,
    onSuccess: 'chmod +x build/*.js'
})