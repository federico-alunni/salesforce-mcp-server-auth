export const DESCRIBE_OBJECT = {
  name: "salesforce_describe_object",
  description: "Get detailed schema metadata including all fields, relationships, and field properties of any Salesforce object.",
  inputSchema: {
    type: "object",
    properties: {
      objectName: { type: "string", description: "API name of the object" }
    },
    required: ["objectName"]
  }
};

export async function handleDescribeObject(conn: any, objectName: string) {
  const describe = await conn.describe(objectName);
  const formattedDescription = `
Object: ${describe.name} (${describe.label})${describe.custom ? ' (Custom Object)' : ''}
Fields:
${describe.fields.map((field: any) => `  - ${field.name} (${field.label})
    Type: ${field.type}${field.length ? `, Length: ${field.length}` : ''}
    Required: ${!field.nillable}
    ${field.referenceTo && field.referenceTo.length > 0 ? `References: ${field.referenceTo.join(', ')}` : ''}
    ${field.picklistValues && field.picklistValues.length > 0 ? `Picklist Values: ${field.picklistValues.map((v: any) => v.value).join(', ')}` : ''}`).join('\n')}`;
  return { content: [{ type: "text", text: formattedDescription }], isError: false };
}
