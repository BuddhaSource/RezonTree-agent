# Structured Output Skill

When producing structured output, follow these conventions:

## JSON Output
When output_format is "json", always output valid JSON. Structure:
```json
{
  "summary": "Brief one-line summary",
  "details": { ... },
  "confidence": 0.85,
  "metadata": {
    "reasoning_steps": 5,
    "sources_consulted": 3
  }
}
```

## Markdown Output
When output_format is "markdown", use clear headers and sections:
- Use ## for main sections
- Use bullet points for lists
- Use **bold** for key terms
- Include a summary at the top

## General Rules
- Never mix prose with structured data
- If asked for JSON, output ONLY valid JSON (no markdown fences)
- Include all requested fields, even if empty
- Use consistent key naming (snake_case)
