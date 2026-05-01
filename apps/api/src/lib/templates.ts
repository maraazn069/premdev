import fs from "node:fs";
import path from "node:path";

export type Template = {
  id: string;
  label: string;
  files: Record<string, string>;
  runCommand: string;
  port: number;
  /** Replit-style hints copied into `.premdev` so the AI knows how to run it. */
  language?: string;
  entrypoint?: string;
  modules?: string[];
};

const TEMPLATES: Template[] = [
  {
    id: "blank",
    label: "Blank",
    files: { "README.md": "# New project\n" },
    runCommand: "echo 'No run command set'",
    port: 3000,
    language: "shell",
  },
  {
    id: "static",
    label: "Static HTML",
    files: {
      "index.html":
        `<!doctype html><html><head><meta charset="utf-8"><title>Hello</title></head>
<body style="font-family:sans-serif;text-align:center;padding:4rem">
<h1>Hello from PremDev 🚀</h1>
<p>Edit <code>index.html</code> to get started.</p>
</body></html>`,
    },
    runCommand: "python3 -m http.server $PORT --bind 0.0.0.0",
    port: 3000,
    language: "html",
    entrypoint: "index.html",
  },
  {
    id: "node",
    label: "Node.js",
    files: {
      "index.js":
`const http = require('http');
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type':'text/html'});
  res.end('<h1>Hello from Node.js</h1>');
}).listen(port, '0.0.0.0', () => console.log('Listening on ' + port));`,
      "package.json":
`{
  "name": "node-app",
  "version": "1.0.0",
  "scripts": { "start": "node index.js" }
}`,
    },
    runCommand: "node index.js",
    port: 3000,
    language: "nodejs",
    entrypoint: "index.js",
    modules: ["nodejs-20"],
  },
  {
    id: "express",
    label: "Express",
    files: {
      "index.js":
`const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (_, res) => res.send('<h1>Hello Express!</h1>'));
app.listen(port, '0.0.0.0', () => console.log('Listening on ' + port));`,
      "package.json":
`{
  "name": "express-app",
  "version": "1.0.0",
  "dependencies": { "express": "^4.21.0" },
  "scripts": { "start": "node index.js" }
}`,
    },
    runCommand: "npm install --silent && node index.js",
    port: 3000,
    language: "nodejs",
    entrypoint: "index.js",
    modules: ["nodejs-20"],
  },
  {
    id: "react",
    label: "React + Vite",
    files: {
      "package.json":
`{
  "name": "react-app",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite --host 0.0.0.0 --port $PORT"
  },
  "dependencies": { "react": "^18.3.1", "react-dom": "^18.3.1" },
  "devDependencies": { "@vitejs/plugin-react": "^4.3.0", "vite": "^5.4.0" }
}`,
      "index.html": `<!doctype html><html><head><meta charset="utf-8"><title>React</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`,
      "vite.config.js": `import react from '@vitejs/plugin-react';\nexport default { plugins: [react()] };`,
      "src/main.jsx": `import React from 'react';\nimport { createRoot } from 'react-dom/client';\ncreateRoot(document.getElementById('root')).render(<h1>Hello React 🚀</h1>);`,
    },
    runCommand: "npm install --silent && npm run dev",
    port: 5173,
    language: "nodejs",
    entrypoint: "src/main.jsx",
    modules: ["nodejs-20"],
  },
  {
    id: "python",
    label: "Python",
    files: {
      "main.py":
`print("Hello from Python!")
print("Edit main.py to get started.")`,
    },
    runCommand: "python3 main.py",
    port: 8000,
    language: "python",
    entrypoint: "main.py",
    modules: ["python-3.12"],
  },
  {
    id: "flask",
    label: "Flask",
    files: {
      "app.py":
`from flask import Flask
import os
app = Flask(__name__)
@app.route('/')
def hello():
    return '<h1>Hello from Flask!</h1>'
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))`,
      "requirements.txt": "flask\n",
    },
    runCommand: "python3 app.py",
    port: 5000,
    language: "python",
    entrypoint: "app.py",
    modules: ["python-3.12"],
  },
  {
    id: "php",
    label: "PHP",
    files: {
      "index.php":
`<?php
echo "<h1>Hello from PHP!</h1>";
echo "<p>Server time: " . date("Y-m-d H:i:s") . "</p>";
phpinfo();
`,
    },
    runCommand: "php -S 0.0.0.0:$PORT -t .",
    port: 8000,
    language: "php",
    entrypoint: "index.php",
    modules: ["php-8.3"],
  },
  {
    id: "laravel",
    label: "Laravel",
    files: {
      ".gitkeep": "",
    },
    runCommand:
      "[ ! -f composer.json ] && composer create-project laravel/laravel . --no-interaction; php artisan serve --host=0.0.0.0 --port=$PORT",
    port: 8000,
    language: "php",
    entrypoint: "public/index.php",
    modules: ["php-8.3"],
  },
  {
    id: "go",
    label: "Go",
    files: {
      "main.go":
`package main
import (
  "fmt"
  "net/http"
  "os"
)
func main() {
  port := os.Getenv("PORT")
  if port == "" { port = "3000" }
  http.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
    fmt.Fprintln(w, "Hello from Go!")
  })
  http.ListenAndServe(":"+port, nil)
}`,
    },
    runCommand: "go run main.go",
    port: 3000,
    language: "go",
    entrypoint: "main.go",
    modules: ["go-1.22"],
  },
  {
    id: "rust",
    label: "Rust",
    files: {
      "Cargo.toml":
`[package]
name = "rust-app"
version = "0.1.0"
edition = "2021"`,
      "src/main.rs": `fn main() { println!("Hello from Rust!"); }`,
    },
    runCommand: "cargo run --release",
    port: 3000,
    language: "rust",
    entrypoint: "src/main.rs",
    modules: ["rust-stable"],
  },
  {
    id: "java",
    label: "Java",
    files: {
      "Main.java":
`public class Main {
  public static void main(String[] args) {
    System.out.println("Hello from Java!");
  }
}`,
    },
    runCommand: "javac Main.java && java Main",
    port: 3000,
    language: "java",
    entrypoint: "Main.java",
    modules: ["java-21"],
  },
  {
    id: "cpp",
    label: "C/C++",
    files: {
      "main.cpp":
`#include <iostream>
int main() { std::cout << "Hello from C++!" << std::endl; return 0; }`,
    },
    runCommand: "g++ main.cpp -o app && ./app",
    port: 3000,
    language: "cpp",
    entrypoint: "main.cpp",
    modules: ["gcc-13"],
  },
  {
    id: "ruby",
    label: "Ruby",
    files: {
      "main.rb": `puts "Hello from Ruby!"`,
    },
    runCommand: "ruby main.rb",
    port: 3000,
    language: "ruby",
    entrypoint: "main.rb",
    modules: ["ruby-3.2"],
  },
];

export function getTemplate(id: string): Template {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}

export function listTemplates() {
  return TEMPLATES.map((t) => ({ id: t.id, label: t.label }));
}

export function applyTemplate(workspaceDir: string, templateId: string) {
  const t = getTemplate(templateId);
  for (const [rel, content] of Object.entries(t.files)) {
    const p = path.join(workspaceDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return t;
}
