export const SEARCH_OBJECTS = {
  name: "salesforce_search_objects",
  description: "Search for Salesforce standard and custom objects by name pattern.",
  inputSchema: {
    type: "object",
    properties: {
      searchPattern: { type: "string", description: "Search pattern to find objects" }
    },
    required: ["searchPattern"]
  }
};

export async function handleSearchObjects(conn: any, searchPattern: string) {
  const describeGlobal = await conn.describeGlobal();
  const searchTerms = searchPattern.toLowerCase().split(' ').filter((term: string) => term.length > 0);
  const matchingObjects = describeGlobal.sobjects.filter((obj: any) => {
    const objectName = obj.name.toLowerCase();
    const objectLabel = obj.label.toLowerCase();
    return searchTerms.every((term: string) => objectName.includes(term) || objectLabel.includes(term));
  });
  if (matchingObjects.length === 0) {
    return { content: [{ type: "text", text: `No Salesforce objects found matching "${searchPattern}".` }], isError: false };
  }
  const formattedResults = matchingObjects.map((obj: any) => `${obj.name}${obj.custom ? ' (Custom)' : ''}\n  Label: ${obj.label}`).join('\n\n');
  return { content: [{ type: "text", text: `Found ${matchingObjects.length} matching objects:\n\n${formattedResults}` }], isError: false };
}
