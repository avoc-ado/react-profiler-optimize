/**
 * Vendored/adapted from:
 * react/packages/react-devtools-shared/src/hooks/astUtils.js
 *
 * This file intentionally ports only the subset needed by parseHookNames
 * (`getHookName` and dependent helpers).
 */

import traverseModule from '@babel/traverse';

const traverse = traverseModule.default ?? traverseModule;

export const NO_HOOK_NAME = '<no-hook>';

const AST_NODE_TYPES = Object.freeze({
  CALL_EXPRESSION: 'CallExpression',
  MEMBER_EXPRESSION: 'MemberExpression',
  ARRAY_PATTERN: 'ArrayPattern',
  IDENTIFIER: 'Identifier',
  NUMERIC_LITERAL: 'NumericLiteral',
  VARIABLE_DECLARATOR: 'VariableDeclarator',
});

function checkNodeLocation(path, line, column = null) {
  const {start, end} = path.node.loc;

  if (line !== start.line) {
    return false;
  }

  if (column !== null) {
    column -= 1;
    if (
      (line === start.line && column < start.column) ||
      (line === end.line && column > end.column)
    ) {
      return false;
    }
  }

  return true;
}

function filterMemberNodesOfTargetHook(targetHookNode, hookNode) {
  const targetHookName = targetHookNode.node.id.name;
  return (
    targetHookName != null &&
    (targetHookName === (hookNode.node.init.object && hookNode.node.init.object.name) ||
      targetHookName === hookNode.node.init.name)
  );
}

function filterMemberWithHookVariableName(hook) {
  return (
    hook.node.init.property.type === AST_NODE_TYPES.NUMERIC_LITERAL &&
    hook.node.init.property.value === 0
  );
}

function getFilteredHookASTNodes(potentialReactHookASTNode, potentialHooksFound) {
  let nodesAssociatedWithReactHookASTNode = [];
  if (nodeContainsHookVariableName(potentialReactHookASTNode)) {
    nodesAssociatedWithReactHookASTNode.unshift(potentialReactHookASTNode);
  } else {
    nodesAssociatedWithReactHookASTNode = potentialHooksFound.filter((hookNode) =>
      filterMemberNodesOfTargetHook(potentialReactHookASTNode, hookNode),
    );
  }
  return nodesAssociatedWithReactHookASTNode;
}

export function getHookName(
  hook,
  originalSourceAST,
  originalSourceCode,
  originalSourceLineNumber,
  originalSourceColumnNumber,
) {
  const hooksFromAST = getPotentialHookDeclarationsFromAST(originalSourceAST);

  let potentialReactHookASTNode = null;
  if (originalSourceColumnNumber === 0) {
    const matchingNodes = hooksFromAST.filter((node) => {
      const nodeLocationCheck = checkNodeLocation(node, originalSourceLineNumber);
      const hookDeclarationCheck = isConfirmedHookDeclaration(node);
      return nodeLocationCheck && hookDeclarationCheck;
    });

    if (matchingNodes.length === 1) {
      potentialReactHookASTNode = matchingNodes[0];
    }
  } else {
    potentialReactHookASTNode = hooksFromAST.find((node) => {
      const nodeLocationCheck = checkNodeLocation(
        node,
        originalSourceLineNumber,
        originalSourceColumnNumber,
      );
      const hookDeclarationCheck = isConfirmedHookDeclaration(node);
      return nodeLocationCheck && hookDeclarationCheck;
    });
  }

  if (!potentialReactHookASTNode) {
    return null;
  }

  try {
    const nodesAssociatedWithReactHookASTNode = getFilteredHookASTNodes(
      potentialReactHookASTNode,
      hooksFromAST,
      originalSourceCode,
    );

    return getHookNameFromNode(
      hook,
      nodesAssociatedWithReactHookASTNode,
      potentialReactHookASTNode,
    );
  } catch {
    return null;
  }
}

function getHookNameFromNode(
  originalHook,
  nodesAssociatedWithReactHookASTNode,
  potentialReactHookASTNode,
) {
  let hookVariableName;
  const isCustomHook = originalHook.id === null;

  switch (nodesAssociatedWithReactHookASTNode.length) {
    case 1:
      if (
        isCustomHook &&
        nodesAssociatedWithReactHookASTNode[0] === potentialReactHookASTNode
      ) {
        hookVariableName = getHookVariableName(potentialReactHookASTNode, isCustomHook);
        break;
      }
      hookVariableName = getHookVariableName(nodesAssociatedWithReactHookASTNode[0]);
      break;

    case 2:
      nodesAssociatedWithReactHookASTNode = nodesAssociatedWithReactHookASTNode.filter((hookPath) =>
        filterMemberWithHookVariableName(hookPath),
      );

      if (nodesAssociatedWithReactHookASTNode.length !== 1) {
        throw new Error("Couldn't isolate AST Node containing hook variable.");
      }
      hookVariableName = getHookVariableName(nodesAssociatedWithReactHookASTNode[0]);
      break;

    default:
      hookVariableName = getHookVariableName(potentialReactHookASTNode);
      break;
  }

  return hookVariableName;
}

function getHookVariableName(hook, isCustomHook = false) {
  const nodeType = hook.node.id.type;
  switch (nodeType) {
    case AST_NODE_TYPES.ARRAY_PATTERN:
      return !isCustomHook ? hook.node.id.elements[0]?.name ?? null : null;
    case AST_NODE_TYPES.IDENTIFIER:
      return hook.node.id.name;
    default:
      return null;
  }
}

function getPotentialHookDeclarationsFromAST(sourceAST) {
  const potentialHooksFound = [];

  traverse(sourceAST, {
    enter(path) {
      if (path.isVariableDeclarator() && isPotentialHookDeclaration(path)) {
        potentialHooksFound.push(path);
      }
    },
  });

  return potentialHooksFound;
}

function isConfirmedHookDeclaration(path) {
  const nodeInit = path.node.init;
  if (nodeInit == null || nodeInit.type !== AST_NODE_TYPES.CALL_EXPRESSION) {
    return false;
  }
  const callee = nodeInit.callee;
  return isHook(callee);
}

function isHook(node) {
  if (node.type === AST_NODE_TYPES.IDENTIFIER) {
    return isHookName(node.name);
  }

  if (
    node.type === AST_NODE_TYPES.MEMBER_EXPRESSION &&
    !node.computed &&
    isHook(node.property)
  ) {
    const obj = node.object;
    const isPascalCaseNameSpace = /^[A-Z].*/;
    return obj.type === AST_NODE_TYPES.IDENTIFIER && isPascalCaseNameSpace.test(obj.name);
  }

  return false;
}

function isHookName(name) {
  return /^use[A-Z0-9].*$/.test(name);
}

function isPotentialHookDeclaration(path) {
  const nodePathInit = path.node.init;
  if (nodePathInit != null) {
    if (nodePathInit.type === AST_NODE_TYPES.CALL_EXPRESSION) {
      return isHook(nodePathInit.callee);
    }

    if (
      nodePathInit.type === AST_NODE_TYPES.MEMBER_EXPRESSION ||
      nodePathInit.type === AST_NODE_TYPES.IDENTIFIER
    ) {
      return true;
    }
  }

  return false;
}

function isReactFunction(node, functionName) {
  return (
    node.name === functionName ||
    (node.type === AST_NODE_TYPES.MEMBER_EXPRESSION &&
      node.object.name === 'React' &&
      node.property.name === functionName)
  );
}

function isBuiltInHookThatReturnsTuple(path) {
  const callee = path.node.init.callee;
  return (
    isReactFunction(callee, 'useState') ||
    isReactFunction(callee, 'useReducer') ||
    isReactFunction(callee, 'useTransition')
  );
}

function nodeContainsHookVariableName(hookNode) {
  const node = hookNode.node.id;
  if (
    node.type === AST_NODE_TYPES.ARRAY_PATTERN ||
    (node.type === AST_NODE_TYPES.IDENTIFIER && !isBuiltInHookThatReturnsTuple(hookNode))
  ) {
    return true;
  }
  return false;
}
