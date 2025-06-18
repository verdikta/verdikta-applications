class ManifestParser {
  async parse(archiveContents) {
    let manifest;
    try {
      // Expect manifest.json to be in the archive contents
      const manifestFile = archiveContents.find(file => file.name === 'manifest.json');
      if (!manifestFile) {
        throw new Error('No manifest.json found in archive');
      }

      manifest = JSON.parse(await manifestFile.text());
    } catch (error) {
      throw new Error(`Invalid manifest file: ${error.message}`);
    }

    // Validate required fields
    if (!manifest.version || !manifest.primary) {
      throw new Error('Invalid manifest: missing required fields "version" or "primary"');
    }

    // Read primary file content
    const primaryContent = await this.readPrimaryFile(archiveContents, manifest.primary);

    // Parse the query and references from primary content
    const { query, references } = this.parsePrimaryContent(primaryContent);

    // Construct AI node payload
    const parsedResult = {
      prompt: query,
      models: this.constructModels(manifest.juryParameters?.AI_NODES || [
        {
          AI_MODEL: "gpt-4",
          AI_PROVIDER: "OpenAI",
          NO_COUNTS: 1,
          WEIGHT: 1.0
        }
      ]),
      iterations: manifest.juryParameters?.ITERATIONS || 1
    };

    // Add additional files section if present
    if (manifest.additional) {
      parsedResult.additional = await Promise.all(manifest.additional.map(async file => {
        const archiveFile = archiveContents.find(f => f.name === file.filename);
        return {
          name: file.name,
          filename: file.filename,
          hash: file.hash,
          type: file.type,
          content: archiveFile ? await archiveFile.arrayBuffer() : null
        };
      }));
    }

    // Add support files section if present
    if (manifest.support) {
      parsedResult.support = manifest.support.map(file => ({
        hash: file.hash
      }));
    }

    return parsedResult;
  }

  async readPrimaryFile(archiveContents, primary) {
    if ((!primary.filename && !primary.hash) || (primary.filename && primary.hash)) {
      throw new Error('Invalid manifest: primary must have either "filename" or "hash", but not both');
    }

    if (primary.filename) {
      const primaryFile = archiveContents.find(file => file.name === primary.filename);
      if (!primaryFile) {
        throw new Error(`Primary file ${primary.filename} not found in archive`);
      }
      return primaryFile.text();
    }

    // Handle external primary files
    if (primary.hash) {
      throw new Error('External primary files (hash-based) are not yet supported');
    }
  }

  parsePrimaryContent(content) {
    // First try parsing as JSON
    try {
      const data = JSON.parse(content);
      if (!data.query) {
        throw new Error('No QUERY found in primary file');
      }
      return {
        query: data.query,
        references: data.references || []
      };
    } catch (jsonError) {
      // If not JSON, try parsing as text with QUERY/REF format
      const lines = content.split('\n');
      const query = lines.find(line => line.trim().startsWith('QUERY:'))?.substring(6).trim();
      const references = lines
        .filter(line => line.trim().startsWith('REF:'))
        .map(line => line.substring(4).trim());

      if (!query) {
        throw new Error('No QUERY found in primary file');
      }

      return { query, references };
    }
  }

  constructModels(aiNodes) {
    return aiNodes.map(node => ({
      provider: node.AI_PROVIDER,
      model: node.AI_MODEL,
      weight: node.WEIGHT,
      count: node.NO_COUNTS
    }));
  }
}

export default new ManifestParser(); 