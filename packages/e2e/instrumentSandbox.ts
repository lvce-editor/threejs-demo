const replacements: readonly (readonly [string, string])[] = [
  [
    'const dynamicCanvasCount = getCanvasCreationCount(scripts);',
    "__threejsPhase('canvas-analysis.begin'); const dynamicCanvasCount = getCanvasCreationCount(scripts); __threejsPhase('canvas-analysis.end');",
  ],
  [
    'await patchCanvasElements(happyDomDocument, uid, dynamicCanvasCount);',
    "__threejsPhase('canvas-reservation.begin'); await patchCanvasElements(happyDomDocument, uid, dynamicCanvasCount); __threejsPhase('canvas-reservation.end');",
  ],
  [
    'const functionNames = getTopLevelFunctionNames(scriptContent);',
    "__threejsPhase('function-analysis.begin', scriptContent.length); const functionNames = getTopLevelFunctionNames(scriptContent); __threejsPhase('function-analysis.end');",
  ],
  [
    'const variableNames = getTopLevelVariableNames(scriptContent);',
    "__threejsPhase('variable-analysis.begin'); const variableNames = getTopLevelVariableNames(scriptContent); __threejsPhase('variable-analysis.end');",
  ],
  [
    "const fn = new Function('window', 'document', 'console', `with (window) { ${scriptContent}${suffix} }`);",
    "__threejsPhase('compile.begin'); const fn = new Function('window', 'document', 'console', `with (window) { ${scriptContent}${suffix} }`); __threejsPhase('compile.end');",
  ],
  [
    'fn.call(window, window, document, runtimeConsole);\n    } catch',
    "__threejsPhase('execute.begin'); fn.call(window, window, document, runtimeConsole); __threejsPhase('execute.end');\n    } catch",
  ],
  [
    'const elementMap = Object.create(null);\n    serialize(happyDomDocument, elementMap);',
    "__threejsPhase('serialize.begin'); const elementMap = Object.create(null);\n    serialize(happyDomDocument, elementMap); __threejsPhase('serialize.end');",
  ],
]

export const instrumentSandbox = (source: string): string => {
  let result = source
  for (const [target, replacement] of replacements) {
    if (result.split(target).length !== 2) throw new Error(`Sandbox diagnostic target is not unique: ${target}`)
    result = result.replace(target, replacement)
  }
  return `const __threejsPhase = (type, length) => console.debug('threejs-startup:' + JSON.stringify({ type, length, time: performance.now() }));\n${result}`
}
