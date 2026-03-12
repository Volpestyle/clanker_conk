import { Project } from "ts-morph";
import * as fs from "fs";

const knipOutput = JSON.parse(fs.readFileSync("knip.json.out", "utf-8"));
const project = new Project();

project.addSourceFilesAtPaths([
  "src/**/*.ts",
  "src/**/*.tsx",
  "dashboard/src/**/*.ts",
  "dashboard/src/**/*.tsx",
  "scripts/**/*.ts"
]);

let changedFiles = 0;

for (const issue of knipOutput.issues) {
  if (!issue.file || (!issue.exports?.length && !issue.types?.length)) continue;
  
  const sourceFile = project.getSourceFile(issue.file);
  if (!sourceFile) {
    console.warn(`Could not find source file: ${issue.file}`);
    continue;
  }

  const namesToUnexport = new Set<string>();
  for (const exp of (issue.exports || [])) namesToUnexport.add(exp.name);
  for (const typ of (issue.types || [])) namesToUnexport.add(typ.name);

  let unexportedCount = 0;

  // Variable statements
  for (const varStatement of sourceFile.getVariableStatements()) {
    if (varStatement.isExported()) {
      const decls = varStatement.getDeclarations();
      if (decls.length === 1 && namesToUnexport.has(decls[0].getName())) {
        varStatement.setIsExported(false);
        unexportedCount++;
      }
    }
  }

  // Functions
  for (const func of sourceFile.getFunctions()) {
    const name = func.getName();
    if (name && func.isExported() && namesToUnexport.has(name)) {
      func.setIsExported(false);
      unexportedCount++;
    }
  }

  // Interfaces
  for (const intf of sourceFile.getInterfaces()) {
    const name = intf.getName();
    if (name && intf.isExported() && namesToUnexport.has(name)) {
      intf.setIsExported(false);
      unexportedCount++;
    }
  }

  // Type Aliases
  for (const typeAlias of sourceFile.getTypeAliases()) {
    const name = typeAlias.getName();
    if (name && typeAlias.isExported() && namesToUnexport.has(name)) {
      typeAlias.setIsExported(false);
      unexportedCount++;
    }
  }
  
  // Classes
  for (const cls of sourceFile.getClasses()) {
    const name = cls.getName();
    if (name && cls.isExported() && namesToUnexport.has(name)) {
      cls.setIsExported(false);
      unexportedCount++;
    }
  }

  if (unexportedCount > 0) {
    console.log(`Unexported ${unexportedCount} items in ${issue.file}`);
    changedFiles++;
  }
}

console.log(`Saving ${changedFiles} files...`);
project.saveSync();
console.log("Done.");
