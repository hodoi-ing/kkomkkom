import * as ts from "typescript";
import type { AuthState, HttpMethod, RouteInfo, Verdict } from "./types.js";

const AUTH_CALLEES = new Set([
  "auth",
  "getServerSession",
  "getToken",
  "verifyToken",
  "requireUser",
  "currentUser",
  "cookies",
  "getSession",
]);
const METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export interface MethodAuth {
  method: HttpMethod;
  state: AuthState;
}

export interface RouteAuth {
  router: "app" | "pages";
  methods: Partial<Record<HttpMethod, MethodAuth>>;
}

function isMethodName(name: string): name is HttpMethod {
  return METHODS.has(name as HttpMethod);
}

function isFunctionNode(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

function hasDefaultModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((modifier) =>
    modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

function hasExport(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node) ?? [];
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
    !modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

function isAuthCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return AUTH_CALLEES.has(callee.text);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (AUTH_CALLEES.has(callee.name.text)) return true;
  if (callee.name.text !== "get") return false;
  const target = callee.expression;
  if (!ts.isCallExpression(target) || !ts.isIdentifier(target.expression)) return false;
  if (target.expression.text !== "headers") return false;
  const arg = node.arguments[0];
  return Boolean(arg && ts.isStringLiteralLike(arg) &&
    arg.text.toLowerCase() === "authorization");
}

function containsAuth(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && isAuthCall(node)) return true;
  return ts.forEachChild(node, containsAuth) ?? false;
}

/** Auth calls that run directly in this body; nested functions are not evidence. */
function scanBody(body: ts.Node): AuthState {
  let signal = false;
  let nested = false;
  const visit = (node: ts.Node) => {
    if (node !== body && isFunctionNode(node)) {
      if (containsAuth(node)) nested = true;
      return;
    }
    if (ts.isCallExpression(node) && isAuthCall(node)) signal = true;
    ts.forEachChild(node, visit);
  };
  visit(body);
  return signal ? "signal" : nested ? "unknown" : "none";
}

function scanFunction(node: ts.Node): AuthState {
  const body = (node as ts.FunctionLikeDeclaration).body;
  if (!body) return "unknown";
  return scanBody(body);
}

function localFunctions(sourceFile: ts.SourceFile): Map<string, ts.Node> {
  const functions = new Map<string, ts.Node>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      functions.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer &&
            isFunctionNode(declaration.initializer)) {
          functions.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }
  return functions;
}

function appMethods(sourceFile: ts.SourceFile): Partial<Record<HttpMethod, ts.Node | null>> {
  const local = localFunctions(sourceFile);
  const methods: Partial<Record<HttpMethod, ts.Node | null>> = {};

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && hasExport(statement) && statement.name &&
        isMethodName(statement.name.text)) {
      methods[statement.name.text] = statement;
    } else if (ts.isVariableStatement(statement) && hasExport(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !isMethodName(declaration.name.text)) continue;
        methods[declaration.name.text] = declaration.initializer &&
          isFunctionNode(declaration.initializer) ? declaration.initializer : null;
      }
    } else if (ts.isExportDeclaration(statement) && statement.exportClause &&
        ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (!isMethodName(element.name.text)) continue;
        methods[element.name.text] = statement.moduleSpecifier
          ? null
          : local.get((element.propertyName ?? element.name).text) ?? null;
      }
    }
  }
  return methods;
}

function methodAccess(expression: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(expression) && expression.name.text === "method" &&
    ts.isIdentifier(expression.expression) &&
    (expression.expression.text === "req" || expression.expression.text === "request");
}

function methodOfTest(expression: ts.Expression): HttpMethod | null {
  if (!ts.isBinaryExpression(expression)) return null;
  const operator = expression.operatorToken.kind;
  if (operator !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
      operator !== ts.SyntaxKind.EqualsEqualsToken) return null;
  for (const [left, right] of [
    [expression.left, expression.right],
    [expression.right, expression.left],
  ] as const) {
    if (methodAccess(left) && ts.isStringLiteralLike(right)) {
      const name = right.text.toUpperCase();
      if (isMethodName(name)) return name;
    }
  }
  return null;
}

interface Branch {
  method: HttpMethod;
  body: ts.Node;
}

function pagesBranches(body: ts.Block): { branches: Branch[]; guarded: boolean } {
  const branches: Branch[] = [];
  const skipped = new Set<ts.Node>();

  for (const statement of body.statements) {
    if (ts.isSwitchStatement(statement) && methodAccess(statement.expression)) {
      for (const clause of statement.caseBlock.clauses) {
        if (!ts.isCaseClause(clause) || !ts.isStringLiteralLike(clause.expression)) continue;
        const name = clause.expression.text.toUpperCase();
        if (!isMethodName(name)) continue;
        branches.push({ method: name, body: clause });
        skipped.add(clause);
      }
    } else if (ts.isIfStatement(statement)) {
      let current: ts.Statement = statement;
      while (ts.isIfStatement(current) && methodOfTest(current.expression)) {
        const method = methodOfTest(current.expression)!;
        branches.push({ method, body: current.thenStatement });
        skipped.add(current.thenStatement);
        const alternate = current.elseStatement;
        if (!alternate || !ts.isIfStatement(alternate) ||
            !methodOfTest(alternate.expression)) break;
        current = alternate;
      }
    }
  }

  let guarded = false;
  const visit = (node: ts.Node) => {
    if (skipped.has(node)) return;
    if (isFunctionNode(node)) {
      if (containsAuth(node)) guarded = true;
      return;
    }
    if (ts.isCallExpression(node) && isAuthCall(node)) guarded = true;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);

  return { branches, guarded };
}

function mergeStates(states: AuthState[]): AuthState {
  if (states.includes("unknown")) return "unknown";
  if (states.includes("signal") && states.includes("none")) return "unknown";
  return states.includes("signal") ? "signal" : "none";
}

function pagesMethods(sourceFile: ts.SourceFile): Partial<Record<HttpMethod, MethodAuth>> {
  const local = localFunctions(sourceFile);
  let handler: ts.Node | null = null;

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && hasDefaultModifier(statement)) {
      handler = statement;
      break;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = statement.expression;
      handler = ts.isIdentifier(expression) ? local.get(expression.text) ?? null : expression;
      break;
    }
  }

  if (!handler || !isFunctionNode(handler) || !(handler as ts.FunctionLikeDeclaration).body) {
    return {};
  }
  const body = (handler as ts.FunctionLikeDeclaration).body;
  if (!body || !ts.isBlock(body)) return {};

  const { branches, guarded } = pagesBranches(body);
  const states = new Map<HttpMethod, AuthState[]>();
  for (const branch of branches) {
    const list = states.get(branch.method) ?? [];
    list.push(guarded ? "unknown" : scanBody(branch.body));
    states.set(branch.method, list);
  }

  const methods: Partial<Record<HttpMethod, MethodAuth>> = {};
  for (const [method, list] of states) {
    methods[method] = { method, state: mergeStates(list) };
  }
  return methods;
}

/**
 * Static evidence only: which method handlers contain an executed auth call.
 * "unknown" means a wrapper, re-export or flow this bounded analysis cannot
 * follow; it is never treated as proof that a route is unprotected.
 */
export function analyzeRoute(route: Pick<RouteInfo, "file" | "source">): RouteAuth {
  const pages = /[\\/]pages[\\/]/.test(route.file) ||
    (route.file === "" && /(?:req|request)\.method|export\s+default\b/.test(route.source));
  const scriptKind = /\.(tsx|jsx)$/.test(route.file)
    ? ts.ScriptKind.TSX
    : /\.(js|mjs|cjs)$/.test(route.file)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    route.file || (pages ? "handler.js" : "route.ts"),
    route.source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  if (pages) {
    return { router: "pages", methods: pagesMethods(sourceFile) };
  }

  const methods: Partial<Record<HttpMethod, MethodAuth>> = {};
  for (const [name, node] of Object.entries(appMethods(sourceFile))) {
    const method = name as HttpMethod;
    methods[method] = { method, state: node ? scanFunction(node) : "unknown" };
  }
  return { router: "app", methods };
}


const AUTH_SIGNALS = [
  /\bauth\s*\(/,
  /getServerSession/,
  /getToken\s*\(/,
  /verifyToken/,
  /requireUser/,
  /currentUser/,
  /cookies\s*\(/,
  /headers\s*\(\s*\)\s*\.get\s*\(\s*["']authorization/i,
];

export function stripComments(source: string): string {
  let out = "";
  let mode: "code" | "single" | "double" | "template" | "line" | "block" = "code";
  let lastClosedParenControl = false;
  const parens: boolean[] = [];

  const regexStart = (): boolean => {
    let i = out.length - 1;
    while (i >= 0 && /\s/.test(out[i])) i -= 1;
    if (i < 0) return true;
    if ("=([{,;:!&|?".includes(out[i])) return true;
    if (out[i] === ">" && out[i - 1] === "=") return true;
    if (out[i] === ")" && lastClosedParenControl) return true;
    const before = out.slice(Math.max(0, i - 8), i + 1);
    return /\b(?:return|case|typeof|instanceof|in|of|new|delete|void|yield|await|throw|else|do)$/.test(before);
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (mode === "code") {
      if (char === "/" && next === "/") {
        mode = "line";
        out += "  ";
        i += 1;
        continue;
      }
      if (char === "/" && next === "*") {
        mode = "block";
        out += "  ";
        i += 1;
        continue;
      }
      if (char === "/" && next !== "/" && next !== "*" && regexStart()) {
        out += char;
        i += 1;
        let inClass = false;
        while (i < source.length) {
          const c = source[i];
          if (c === "\\") {
            out += c + (source[i + 1] ?? "");
            i += 2;
            continue;
          }
          out += c;
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          else if (c === "/" && !inClass) break;
          i += 1;
        }
        continue;
      }
      if (char === "(") {
        let j = out.length - 1;
        while (j >= 0 && /\s/.test(out[j])) j -= 1;
        const end = j + 1;
        while (j >= 0 && /[A-Za-z]/.test(out[j])) j -= 1;
        const word = out.slice(j + 1, end);
        while (j >= 0 && /\s/.test(out[j])) j -= 1;
        const control = /^(?:if|while|for|with|switch|catch)$/.test(word) &&
          !/[.?#_$0-9]/.test(j >= 0 ? out[j] : "");
        parens.push(control);
        lastClosedParenControl = false;
        out += char;
        continue;
      }
      if (char === ")") {
        lastClosedParenControl = parens.pop() ?? false;
        out += char;
        continue;
      }
      if (char === "'") mode = "single";
      else if (char === '"') mode = "double";
      else if (char === "`") mode = "template";
      out += char;
      continue;
    }

    if (mode === "line") {
      if (char === "\n") {
        mode = "code";
        out += char;
      } else {
        out += " ";
      }
      continue;
    }

    if (mode === "block") {
      if (char === "*" && next === "/") {
        mode = "code";
        out += "  ";
        i += 1;
        continue;
      }
      out += char === "\n" ? "\n" : " ";
      continue;
    }

    out += char;
    if (char === "\\") {
      if (i + 1 < source.length) out += source[i + 1];
      i += 1;
      continue;
    }
    if (
      (mode === "single" && char === "'") ||
      (mode === "double" && char === '"') ||
      (mode === "template" && char === "`")
    ) {
      mode = "code";
    }
  }

  return out;
}

export function hasAuthSignal(source: string): boolean {
  const code = stripComments(source);
  return AUTH_SIGNALS.some((signal) => signal.test(code));
}

export function classify(status: number, hasSignal: boolean): Verdict {
  if (status === 401 || status === 403) return "locked";
  if (status >= 300 && status < 400) return "check";
  if (status >= 500) return "error";
  if (status === 404 || status === 405) return "unknown";
  if (status >= 200 && status < 300) return hasSignal ? "exposed" : "check";
  return "unknown";
}

export function matchesGlob(path: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}
