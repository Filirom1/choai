export interface PayeeAndNote {
  readonly payee: string
  readonly note: string
}

export const payeeAndNote = (description: string): PayeeAndNote => {
  const separator = description.indexOf("|")
  return separator < 0
    ? { payee: description.trim(), note: "" }
    : { payee: description.slice(0, separator).trim(), note: description.slice(separator + 1).trim() }
}
