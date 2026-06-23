import { Command } from "commander";
import { processWatch } from "../../packages/processing/src/index.js";

const program = new Command();

program
  .name("process-watch")
  .description("Phase 0 watch processing prototype")
  .requiredOption("-i, --input <path>", "input PNG path")
  .requiredOption("-o, --output <path>", "output PNG path")
  .requiredOption("-w, --width-mm <number>", "watch width measurement in mm", Number.parseFloat)
  .requiredOption("-l, --left-boundary <number>", "left boundary in original image px", Number.parseInt)
  .requiredOption("-r, --right-boundary <number>", "right boundary in original image px", Number.parseInt);

program.parse();

const options = program.opts<{
  input: string;
  output: string;
  widthMm: number;
  leftBoundary: number;
  rightBoundary: number;
}>();

const result = await processWatch({
  inputPath: options.input,
  outputPath: options.output,
  widthMm: options.widthMm,
  leftBoundary: options.leftBoundary,
  rightBoundary: options.rightBoundary
});

console.log(JSON.stringify(result, null, 2));
