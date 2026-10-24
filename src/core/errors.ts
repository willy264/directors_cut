/** A scaffold must fail explicitly instead of pretending to validate or execute. */
export class NotImplementedError extends Error {
  constructor(functionName: string) {
    super(`${functionName} is a scaffold stub. Implement its core tests first.`);
    this.name = "NotImplementedError";
  }
}
