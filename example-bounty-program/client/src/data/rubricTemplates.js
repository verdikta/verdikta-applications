/**
 * Predefined Rubric Templates
 * Based on rubric-1 schema
 */

export const rubricTemplates = {
  blogPost: {
    version: "rubric-1",
    title: "Blog Post for Verdikta.org",
    threshold: 82,
    criteria: [
      {
        id: "safety_and_rights",
        label: "Forbidden content & rights",
        must: true,
        weight: 0.0,
        instructions: "Reject if NSFW, hate/harassment, or infringes copyright; reject if license terms not met."
      },
      {
        id: "originality",
        label: "Originality / Non-plagiarism",
        must: true,
        weight: 0.0,
        instructions: "Reject if substantially copied without citation."
      },
      {
        id: "relevance",
        label: "Relevance to brief",
        must: false,
        weight: 0.20,
        instructions: "Directly addresses requested topic and audience."
      },
      {
        id: "accuracy",
        label: "Technical accuracy",
        must: false,
        weight: 0.20,
        instructions: "Definitions/examples correct; no major factual errors."
      },
      {
        id: "structure",
        label: "Structure & formatting",
        must: false,
        weight: 0.15,
        instructions: "Meets requested length, headings, links, assets."
      },
      {
        id: "style",
        label: "Clarity & readability",
        must: false,
        weight: 0.15,
        instructions: "Clear, concise, minimal grammar issues."
      },
      {
        id: "overall_quality",
        label: "Overall quality / publishability",
        must: false,
        weight: 0.30,
        instructions: "Holistic judgment: is this genuinely useful and publishable on Verdikta.org?"
      }
    ],
    forbiddenContent: [
      "NSFW/sexual content",
      "Hate speech or harassment",
      "Copyrighted material without permission"
    ]
  },

  codeReview: {
    version: "rubric-1",
    title: "Code Review & Quality Assessment",
    threshold: 75,
    criteria: [
      {
        id: "safety",
        label: "Security & Safety",
        must: true,
        weight: 0.0,
        instructions: "Reject if contains obvious security vulnerabilities, malicious code, or unsafe practices."
      },
      {
        id: "functionality",
        label: "Functionality & Correctness",
        must: false,
        weight: 0.30,
        instructions: "Code works as intended, handles edge cases, no critical bugs."
      },
      {
        id: "code_quality",
        label: "Code Quality & Style",
        must: false,
        weight: 0.20,
        instructions: "Clean, readable, follows conventions, properly structured."
      },
      {
        id: "documentation",
        label: "Documentation & Comments",
        must: false,
        weight: 0.15,
        instructions: "Adequate comments, clear function/class documentation."
      },
      {
        id: "testing",
        label: "Testing & Coverage",
        must: false,
        weight: 0.15,
        instructions: "Includes tests, good coverage, tests are meaningful."
      },
      {
        id: "performance",
        label: "Performance & Efficiency",
        must: false,
        weight: 0.20,
        instructions: "Efficient algorithms, no obvious performance issues."
      }
    ],
    forbiddenContent: [
      "Malicious code",
      "Security vulnerabilities",
      "Plagiarized code without attribution"
    ]
  },

  technicalWriting: {
    version: "rubric-1",
    title: "Technical Documentation",
    threshold: 80,
    criteria: [
      {
        id: "plagiarism",
        label: "Originality Check",
        must: true,
        weight: 0.0,
        instructions: "Reject if plagiarized or copied without proper attribution."
      },
      {
        id: "completeness",
        label: "Completeness",
        must: false,
        weight: 0.25,
        instructions: "Covers all required topics, no major gaps in coverage."
      },
      {
        id: "accuracy",
        label: "Technical Accuracy",
        must: false,
        weight: 0.25,
        instructions: "Information is correct, up-to-date, and technically sound."
      },
      {
        id: "clarity",
        label: "Clarity & Structure",
        must: false,
        weight: 0.20,
        instructions: "Well-organized, easy to follow, logical flow."
      },
      {
        id: "examples",
        label: "Examples & Code Samples",
        must: false,
        weight: 0.15,
        instructions: "Includes helpful examples, code samples work as shown."
      },
      {
        id: "usability",
        label: "Usability for Target Audience",
        must: false,
        weight: 0.15,
        instructions: "Appropriate level of detail for intended audience."
      }
    ],
    forbiddenContent: [
      "Plagiarized content",
      "Offensive language",
      "Misleading information"
    ]
  },

  designWork: {
    version: "rubric-1",
    title: "Design Work Assessment",
    threshold: 78,
    criteria: [
      {
        id: "originality",
        label: "Original Work",
        must: true,
        weight: 0.0,
        instructions: "Reject if copied, plagiarized, or violates copyright."
      },
      {
        id: "requirements",
        label: "Meets Requirements",
        must: false,
        weight: 0.25,
        instructions: "Fulfills all specified requirements and constraints."
      },
      {
        id: "aesthetics",
        label: "Visual Aesthetics",
        must: false,
        weight: 0.25,
        instructions: "Visually appealing, good use of color, typography, spacing."
      },
      {
        id: "usability",
        label: "Usability & UX",
        must: false,
        weight: 0.20,
        instructions: "Intuitive, user-friendly, follows UX best practices."
      },
      {
        id: "creativity",
        label: "Creativity & Innovation",
        must: false,
        weight: 0.15,
        instructions: "Shows creative thinking, unique approach."
      },
      {
        id: "technical",
        label: "Technical Quality",
        must: false,
        weight: 0.15,
        instructions: "Proper file formats, resolution, deliverables complete."
      }
    ],
    forbiddenContent: [
      "Copyrighted material",
      "Offensive imagery",
      "Plagiarized designs"
    ]
  },

  videoContent: {
    version: "rubric-1",
    title: "Video Content Production",
    threshold: 75,
    criteria: [
      {
        id: "content_safety",
        label: "Content Safety",
        must: true,
        weight: 0.0,
        instructions: "Reject if NSFW, contains hate speech, or violates copyright."
      },
      {
        id: "content_quality",
        label: "Content Quality & Relevance",
        must: false,
        weight: 0.25,
        instructions: "Addresses topic thoroughly, engaging, informative."
      },
      {
        id: "production",
        label: "Production Quality",
        must: false,
        weight: 0.25,
        instructions: "Good video/audio quality, proper lighting, clear sound."
      },
      {
        id: "editing",
        label: "Editing & Flow",
        must: false,
        weight: 0.20,
        instructions: "Well-edited, good pacing, smooth transitions."
      },
      {
        id: "presentation",
        label: "Presentation Skills",
        must: false,
        weight: 0.15,
        instructions: "Clear delivery, engaging presence, professional."
      },
      {
        id: "length",
        label: "Length & Format",
        must: false,
        weight: 0.15,
        instructions: "Appropriate length, correct format/resolution."
      }
    ],
    forbiddenContent: [
      "NSFW content",
      "Copyrighted music/footage",
      "Hate speech"
    ]
  },

  general: {
    version: "rubric-1",
    title: "General Work Submission",
    threshold: 80,
    criteria: [
      {
        id: "prohibited",
        label: "Prohibited Content",
        must: true,
        weight: 0.0,
        instructions: "Reject if contains NSFW, hate speech, or copyright violations."
      },
      {
        id: "requirements",
        label: "Meets Requirements",
        must: false,
        weight: 0.35,
        instructions: "Fulfills all stated requirements and specifications."
      },
      {
        id: "quality",
        label: "Overall Quality",
        must: false,
        weight: 0.35,
        instructions: "Professional quality, attention to detail, well-executed."
      },
      {
        id: "completeness",
        label: "Completeness",
        must: false,
        weight: 0.30,
        instructions: "Complete submission, nothing missing, ready to use."
      }
    ],
    forbiddenContent: [
      "NSFW content",
      "Hate speech",
      "Copyright violations"
    ]
  }
};

/**
 * Get list of template options for UI
 */
export const getTemplateOptions = () => {
  return [
    { value: '', label: 'Create from Scratch' },
    { value: 'blogPost', label: '📝 Blog Post' },
    { value: 'codeReview', label: '💻 Code Review' },
    { value: 'technicalWriting', label: '📚 Technical Documentation' },
    { value: 'designWork', label: '🎨 Design Work' },
    { value: 'videoContent', label: '🎥 Video Content' },
    { value: 'general', label: '📋 General Submission' }
  ];
};

/**
 * Get a template by key
 */
export const getTemplate = (key) => {
  return rubricTemplates[key] || null;
};

/**
 * Create a blank rubric structure
 */
export const createBlankRubric = () => {
  return {
    version: "rubric-1",
    title: "",
    threshold: 80,
    criteria: [
      {
        id: "quality",
        label: "Overall Quality",
        must: false,
        weight: 1.0,
        instructions: "General quality assessment."
      }
    ],
    forbiddenContent: [
      "NSFW content",
      "Hate speech",
      "Copyright violations"
    ]
  };
};

