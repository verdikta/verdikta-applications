/**
 * Augments the query text with hyperlinks and their descriptions
 * @param {string} originalQuery - The original query text
 * @param {Array<{url: string, description: string}>} links - Array of hyperlinks with descriptions
 * @returns {string} The augmented query text with hyperlinks
 */
export const getAugmentedQueryText = (originalQuery, links) => {
  if (!links || links.length === 0) return originalQuery;
  
  const linkSection = links
    .filter(link => link.url && link.url.trim())
    .map(link => {
      const description = link.description ? `    ${link.description}` : '';
      return `${link.url}${description}`;
    })
    .join('\n');
    
  return linkSection ? `${originalQuery}\n\nReference URLs to review:\n${linkSection}` : originalQuery;
}; 