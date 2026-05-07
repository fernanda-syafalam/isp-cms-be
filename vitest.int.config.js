"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const unplugin_swc_1 = __importDefault(require("unplugin-swc"));
const config_1 = require("vitest/config");
exports.default = (0, config_1.defineConfig)({
    plugins: [
        unplugin_swc_1.default.vite({
            module: { type: 'es6' },
            jsc: {
                parser: { syntax: 'typescript', decorators: true },
                transform: { decoratorMetadata: true, legacyDecorator: true },
                target: 'es2022',
            },
        }),
    ],
    test: {
        globals: true,
        environment: 'node',
        setupFiles: ['./test/setup.ts'],
        include: ['src/**/*.int-spec.ts'],
        pool: 'forks',
        poolOptions: { forks: { singleFork: true } },
        testTimeout: 60_000,
        hookTimeout: 60_000,
    },
});
//# sourceMappingURL=vitest.int.config.js.map