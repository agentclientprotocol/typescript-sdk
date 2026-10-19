import { posix as path } from "node:path";

const SPEC_TABLES = new Set([
  "agentRequestSpecs",
  "agentNotificationSpecs",
  "clientRequestSpecs",
  "clientNotificationSpecs",
]);
const HANDLER_TABLES = new Set([
  "AgentRequestHandlersByMethod",
  "AgentNotificationHandlersByMethod",
  "ClientRequestHandlersByMethod",
  "ClientNotificationHandlersByMethod",
]);
// Omit explicit unstable binding-table entries, never arbitrary
// executable code just because it depends on an unavailable schema definition.
export function generateBindings(ts, template, definitions, metadata, config) {
  const source = ts.createSourceFile(
    config.bindingsSource,
    template,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (source.parseDiagnostics.length > 0) {
    throw new Error(
      `Cannot parse ${config.bindingsSource}: ${source.parseDiagnostics
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        )
        .join("\n")}`,
    );
  }
  const constants = {
    AGENT_METHODS: metadata.agentMethods,
    CLIENT_METHODS: metadata.clientMethods,
    PROTOCOL_METHODS: metadata.protocolMethods,
  };
  const guards = new Set(config.expectedExtensibleUnions);

  function qualifiedName(node) {
    if (ts.isIdentifier(node)) return [node.text];
    if (ts.isPropertyAccessExpression(node)) {
      return [...qualifiedName(node.expression), node.name.text];
    }
    if (ts.isQualifiedName(node)) {
      return [...qualifiedName(node.left), node.right.text];
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      return [...qualifiedName(node.expression), node.argumentExpression.text];
    }
    return [];
  }

  function unavailable(node) {
    const [namespace, name, member] = qualifiedName(node);
    if (namespace === "schema" && name) {
      if (Object.hasOwn(constants, name)) {
        if (member && !Object.hasOwn(constants[name], member)) {
          return `schema.${name}.${member}`;
        }
      } else if (
        name !== "PROTOCOL_VERSION" &&
        !Object.hasOwn(definitions, name)
      ) {
        return `schema.${name}`;
      }
    }
    if (
      namespace === "validate" &&
      name?.startsWith("z") &&
      !Object.hasOwn(definitions, name.slice(1))
    ) {
      return `validate.${name}`;
    }
    return ts.forEachChild(node, unavailable);
  }

  function isMethodReference(node) {
    const parts = qualifiedName(node);
    return (
      parts.length === 3 &&
      parts[0] === "schema" &&
      Object.hasOwn(constants, parts[1])
    );
  }

  function isUnstableName(node) {
    return (
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text.startsWith("unstable_")
    );
  }

  function unwrap(node) {
    while (
      node &&
      (ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isParenthesizedExpression(node))
    ) {
      node = node.expression;
    }
    return node;
  }

  function isExported(node) {
    return node.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
  }

  // Index omission boundaries once, from the SDK's top-level declarations.
  // The visitor below must not infer that an arbitrary payload is a method
  // table.
  const declarations = new Set();
  const methodEntries = new Set();
  const methodGroups = new Set();
  const handlerEntries = new Set();

  function collectMethods(object) {
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const initializer = unwrap(property.initializer);
      if (isMethodReference(initializer)) {
        methodEntries.add(property);
      } else if (ts.isObjectLiteralExpression(initializer)) {
        if (initializer.properties.length > 0) methodGroups.add(property);
        collectMethods(initializer);
      }
    }
  }

  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
          continue;
        const name = declaration.name.text;
        const initializer = unwrap(declaration.initializer);
        if (name === "methods" && ts.isObjectLiteralExpression(initializer)) {
          collectMethods(initializer);
        } else if (
          SPEC_TABLES.has(name) &&
          ts.isObjectLiteralExpression(initializer)
        ) {
          for (const property of initializer.properties) {
            if (ts.isPropertyAssignment(property) && isUnstableName(property)) {
              declarations.add(property);
            }
          }
        }
      }
    } else if (
      ts.isTypeAliasDeclaration(statement) &&
      HANDLER_TABLES.has(statement.name.text) &&
      isExported(statement) &&
      ts.isTypeLiteralNode(statement.type)
    ) {
      for (const member of statement.type.members) {
        if (
          ts.isPropertySignature(member) &&
          ts.isComputedPropertyName(member.name) &&
          isMethodReference(member.name.expression)
        ) {
          handlerEntries.add(member);
        }
      }
    }
  }

  function modulePath(specifier) {
    // Each binding uses its own generated schema, but the same JSON-RPC engine,
    // streams and deserialization helpers. Never route through the other API.
    if (!specifier.startsWith(".")) return specifier;
    const schemaPrefix = "./unstable/schema/";
    const target = specifier.startsWith(schemaPrefix)
      ? path.join(config.outputDir, specifier.slice(schemaPrefix.length))
      : path.join(path.dirname(config.bindingsSource), specifier);
    const relative = path.relative(path.dirname(config.bindingsPath), target);
    return relative.startsWith(".") ? relative : `./${relative}`;
  }

  const result = ts.transform(source, [
    (context) => {
      function visit(node) {
        if (declarations.has(node) && unavailable(node)) {
          return undefined;
        }
        if (handlerEntries.has(node) && unavailable(node.name.expression)) {
          return undefined;
        }
        if (methodEntries.has(node) && unavailable(node.initializer)) {
          return undefined;
        }
        if (ts.isImportDeclaration(node)) {
          return ts.factory.updateImportDeclaration(
            node,
            node.modifiers,
            node.importClause,
            ts.factory.createStringLiteral(
              modulePath(node.moduleSpecifier.text),
            ),
            node.attributes,
          );
        }
        if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
          let clause = node.exportClause;
          if (
            node.moduleSpecifier.text === "./unstable/schema/guards.gen.js" &&
            clause &&
            ts.isNamedExports(clause)
          ) {
            clause = ts.factory.updateNamedExports(
              clause,
              clause.elements.filter((element) =>
                guards.has((element.propertyName ?? element.name).text),
              ),
            );
          }
          return ts.factory.updateExportDeclaration(
            node,
            node.modifiers,
            node.isTypeOnly,
            clause,
            ts.factory.createStringLiteral(
              modulePath(node.moduleSpecifier.text),
            ),
            node.attributes,
          );
        }
        const visited = ts.visitEachChild(node, visit, context);
        const initializer = methodGroups.has(node)
          ? unwrap(visited.initializer)
          : undefined;
        if (
          initializer &&
          ts.isObjectLiteralExpression(initializer) &&
          initializer.properties.length === 0
        ) {
          return undefined;
        }
        return visited;
      }
      return (root) => ts.visitNode(root, visit);
    },
  ]);
  try {
    const missing = unavailable(result.transformed[0]);
    if (missing) {
      throw new Error(
        `[${config.name}] Cannot project ${missing} into this schema binding. ` +
          "Keep unstable behavior in a recognized binding table; " +
          "shared executable code must work with both schemas.",
      );
    }
    return (
      `// Generated from ${path.normalize(config.bindingsSource)}. Do not edit directly.\n` +
      ts
        .createPrinter({ newLine: ts.NewLineKind.LineFeed })
        .printFile(result.transformed[0])
    );
  } finally {
    result.dispose();
  }
}
