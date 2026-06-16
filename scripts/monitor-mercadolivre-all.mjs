import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forwarded = process.argv.slice(2);

// Resiliência: roda AMBOS mesmo se um falhar. Antes, uma falha nos notebooks
// rejeitava o await e as watchlists nunca rodavam — e, se os notebooks travassem
// antes de gravar, nada era escrito (sintoma do "não deu certo"). Cada script
// grava seu próprio relatório; só sinalizamos erro no fim, sem impedir o outro.
const errors = [];
for (const script of ["monitor-mercadolivre-notebooks.mjs", "monitor-mercadolivre-watchlists.mjs"]) {
  try {
    await run(script, forwarded);
  } catch (error) {
    console.error(`Aviso: ${error.message}`);
    errors.push(error.message);
  }
}
if (errors.length) process.exitCode = 1;

function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "scripts", script), ...args], {
      cwd: root,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${script} saiu com codigo ${code}`)));
  });
}
