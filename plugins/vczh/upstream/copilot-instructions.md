# General Instruction

- `REPO-ROOT` refers to the root directory of the repository.
- Solutions and projects you need to work on can be found in `REPO-ROOT/Project.md`.
- Following `Leveraging the Knowledge Base`, find the knowledge and documents for this project in `REPO-ROOT/.github/KnowledgeBase/Index.md`.
- Before writing to a source file, read it again and make sure you respect my parallel editing.
- If any `*.prompt.md` file is referenced, take immediate action following the instructions in that file.
- **DO NOT ASK ANY QUESTION** if you are not explicitly instructed to ask questions. Run the user's task to the end.
  - The only exception is when there is seriously conflicting information in the user's task. This is rare; try your best to resolve the ambiguity by yourself, and only ask when you are totally stuck.


## Coding Guidelines

- **SUPER IMPORTANT** Your should always follow the coding convention when coding:
  - Use `vczh prompt list` to find conventions whose `enabled` field is true; read only those with `vczh prompt show <id>`.
  - Disabled conventions, including general and cpp, must not be loaded or re-enabled unless the user asks.
  - `REPO-ROOT/.github/KnowledgeBase/Learning.md`
  - `REPO-ROOT/.github/Learning/Learning_Coding.md`
  - `REPO-ROOT/.github/Learning/Learning_Testing.md`
- Read this project's `Project.md` for its build, test, debugging and source-file conventions.

## Accessing Task Documents

If you need to find any document for the current working task, they are in the `REPO-ROOT/.github/TaskLogs` folder:
- `Copilot_Investigate.md`
- `Copilot_KB.md`

### Important Rules for Writing Markdown Files

- Do not print "````````" or "````````markdown" in a Markdown file.
- It is totally fine to have multiple top-level `# Topic`.
- When mentioning a C++ name in a Markdown file:
  - If it is defined in the standard C++ library or third-party library, use the full name.
  - If it is defined in the source code, use the full name if there is ambiguity, and then mention the file containing its definition.


## Leveraging the Knowledge Base

- When making design or coding decisions, you must leverage the knowledge base to make the best choice.
- The main entry is `REPO-ROOT/.github/KnowledgeBase/Index.md`, it is organized in this way:
  - `## Guidance`: General guidance that plays an important role repo-wide.
  - Each `## Project`: A brief description of each project and its purpose, plus a link to `Index_<PROJECT>.md` for project-specific guidance.
  - Each `Index_<PROJECT>.md`: Project-specific API and design guidance linked from the project section in `Index.md`.
    - `### Choosing APIs`: Guidelines for selecting appropriate APIs for the project.
    - `### Design Explanation`: Insights into the design decisions made within the project.
  - `## Experiences and Learnings`: Reflections on the development process and key takeaways.
  - `# Copy of Online Manual`: A copy of the online manual so that you don't need network access. They are much more detailed, offering selectively important information.
    - Each `## Project`: A copy of online manual for that project, organized in the same way as the knowledge base.
    - Not every project is included.
    - Manual for the unit test framework is in `## Unit Testing`.

### Index_<PROJECT>.md/Choosing APIs

There are multiple categories under `Choosing APIs`. Each category begins with a short and accurate title `#### Category`.
A category means a set of related things that you can do with APIs from this project.

Under the category, there is an overall and comprehensive description about what you can do.

Under the description, there are bullet points, and each item follows the format:  `- Use CLASS-NAME for blahblahblah` (If a function does not belong to a class, you can generate `Use FUNCTION-NAME ...`).
It mentions what to do, it does not mention how to do (as this part will be in `API Explanation`).
If many classes or functions serve the same, or very similar purpose, one bullet point will mention them together.

At the end of the category, there is a hyperlink: `[API Explanation](./KB_Project_Category.md)` (no space between file name, all PascalCase).

### Index_<PROJECT>.md/Design Explanation

There are multiple topics under `Design Explanation`. Each topic begins with a short and accurate title `#### Topic`.
A topic means a feature of this project; it can involve multiple components combined.

Under the topic, there is an overall and comprehensive description about what this feature does.

Under the description, there are bullet points to provide a little more detail, but do not make it too long. Full details are supposed to be in the document from the hyperlink.

At the end of the topic, there is a hyperlink: `[Design Explanation](./KB_Project_Design_Topic.md)` (no space between file name, all PascalCase).

### Experiences and Learnings

(to edit ...)
