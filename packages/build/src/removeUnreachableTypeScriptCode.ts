// TypeScript 6 emits this unused enum inside withContext, after its return.
// Its consumers use inlined numeric literals. Remove only this dead initializer
// so Firefox does not warn when parsing the compiler, including bundled copies.
export const removeUnreachableTypeScriptCode = (source: string): string => {
  return source.replace(
    /\s*let ExpressionType;\s*\(\(ExpressionType2\) => \{\s*ExpressionType2\[ExpressionType2\["Text"\] = 0\] = "Text";\s*ExpressionType2\[ExpressionType2\["Computed"\] = 1\] = "Computed";\s*ExpressionType2\[ExpressionType2\["ArrayAccess"\] = 2\] = "ArrayAccess";\s*ExpressionType2\[ExpressionType2\["Identifier"\] = 3\] = "Identifier";\s*\}\)\(ExpressionType \|\| \(ExpressionType = \{\}\)\);/,
    '',
  )
}
