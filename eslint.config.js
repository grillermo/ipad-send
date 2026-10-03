export default [
  {
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: "script",
      globals: {
        window: "readonly",
        document: "readonly",
        XMLHttpRequest: "readonly",
        localStorage: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-restricted-properties": [
        "error",
        { property: "bind", message: "Safari 5.1 (iOS 5) has no Function.prototype.bind." },
      ],
    },
  },
];
