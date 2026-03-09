import tailwind from "eslint-plugin-tailwindcss";
import tsParser from "@typescript-eslint/parser";

export default [
  // Ignore non-JS/TS files
  { ignores: ["**/*.css"] },

  // Default: ban arbitrary Tailwind values everywhere
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
    },
    plugins: {
      tailwindcss: tailwind,
    },
    settings: {
      tailwindcss: {
        callees: ["cn", "cva", "clsx"],
        classRegex: "^class(Name)?$",
        config: {},
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      "tailwindcss/no-arbitrary-value": "error",
    },
  },
  // Enforce design-system components in app pages and thread components
  {
    files: [
      "src/app/**/*.tsx",
      "src/components/thread/**/*.tsx",
      "src/components/dashboard/**/*.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXOpeningElement[name.name='button'][attributes.length>0]",
          message: "Use <Button> or <SheetAction> from components/ui/ instead of raw <button>.",
        },
        {
          selector: "JSXOpeningElement[name.name='input']",
          message: "Use <Input> from components/ui/ instead of raw <input>.",
        },
        {
          selector: "JSXOpeningElement[name.name='select']",
          message: "Use <Select> from components/ui/ instead of raw <select>.",
        },
        {
          selector: "JSXOpeningElement[name.name='textarea']",
          message: "Use <Textarea> from components/ui/ instead of raw <textarea>.",
        },
      ],
    },
  },
  // Allow arbitrary values and raw elements in UI primitives, ai-elements, and design system files
  {
    files: [
      "src/components/ui/**",
      "src/components/ai-elements/**",
      "src/app/uikit/**",
      "src/app/layout.tsx",
    ],
    rules: {
      "tailwindcss/no-arbitrary-value": "off",
      "no-restricted-syntax": "off",
    },
  },
];
