export type ElicitationOption = { const: string | number | boolean; title?: string; description?: string };
export type ElicitationField = {
  type?: string; title?: string; description?: string; enum?: (string | number | boolean)[]; enumNames?: string[];
  oneOf?: ElicitationOption[]; anyOf?: ElicitationOption[]; items?: ElicitationField;
  minLength?: number; maxLength?: number; minimum?: number; maximum?: number; minItems?: number; maxItems?: number;
  _meta?: { codex?: { isSecret?: boolean; questionId?: string; role?: string } };
};
export type ElicitationRequest = {
  elicitationRequestId: string; sessionId?: string; message: string;
  schema: { type?: string; properties: Record<string, ElicitationField>; required?: string[] };
};
export type ElicitationPage = { id: string; fields: [string, ElicitationField][] };

/** Companion answer fields stay with their question, even when JSON orders them first. */
export function elicitationPages(request: ElicitationRequest): ElicitationPage[] {
  const fields = Object.entries(request.schema.properties);
  const notes = new Map<string, string>();
  for (const [name, field] of fields) {
    const meta = field._meta?.codex;
    // Claude ACP emits question_<index>_custom without metadata for ordinary clients.
    const claudeParent = field.type === 'string' && /^question_\d+_custom$/.test(name) ? name.slice(0, -7) : undefined;
    const parent = meta?.role === 'user_note' ? meta.questionId : name.endsWith('_note') ? name.slice(0, -5) : claudeParent;
    if (parent && parent !== name && Object.hasOwn(request.schema.properties, parent)) notes.set(name, parent);
  }
  const pages = fields.filter(([name]) => !notes.has(name)).map(([name, field]) => ({ id: name, fields: [[name, field]] as [string, ElicitationField][] }));
  for (const [name, field] of fields) {
    const page = pages.find(item => item.id === notes.get(name));
    if (page) page.fields.push([name, field]);
    else if (notes.has(name)) pages.push({ id: name, fields: [[name, field]] });
  }
  return pages;
}

export function elicitationPageError(request: ElicitationRequest, page: ElicitationPage, answers: Record<string, unknown>) {
  return elicitationError({ ...request, schema: { ...request.schema, properties: Object.fromEntries(page.fields),
    required: request.schema.required?.filter(name => page.fields.some(([key]) => key === name)) } }, answers);
}

export function elicitationOptions(field: ElicitationField): ElicitationOption[] {
  return field.oneOf || field.anyOf || field.enum?.map((value, index) => ({ const: value, title: field.enumNames?.[index] || String(value) })) || [];
}

export function elicitationContent(request: ElicitationRequest, answers: Record<string, unknown>) {
  const entries: [string, unknown][] = [];
  for (const name of Object.keys(request.schema.properties)) {
    if (!Object.hasOwn(answers, name)) continue;
    const value = answers[name];
    if (value !== undefined && value !== '' && !(typeof value === 'number' && !Number.isFinite(value))) entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}

export function elicitationError(request: ElicitationRequest, answers: Record<string, unknown>) {
  const content = elicitationContent(request, answers);
  for (const name of request.schema.required || []) if (!(name in content)) return `请填写“${request.schema.properties[name]?.title || name}”`;
  for (const [name, value] of Object.entries(content)) {
    const field = request.schema.properties[name];
    const title = field.title || name;
    const choices = elicitationOptions(field);
    if (choices.length && !choices.some(option => option.const === value)) return `请选择“${title}”的有效选项`;
    if (typeof value === 'string' && ((field.minLength != null && value.length < field.minLength) || (field.maxLength != null && value.length > field.maxLength))) return `“${title}”的长度不符合要求`;
    if (typeof value === 'number' && ((field.type === 'integer' && !Number.isInteger(value)) || (field.minimum != null && value < field.minimum) || (field.maximum != null && value > field.maximum))) return `“${title}”的数值不符合要求`;
    if (Array.isArray(value) && ((field.minItems != null && value.length < field.minItems) || (field.maxItems != null && value.length > field.maxItems))) return `“${title}”的选项数量不符合要求`;
  }
  return '';
}
