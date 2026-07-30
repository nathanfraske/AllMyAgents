<script lang="ts">
  import type { QuestionRecord } from './api'

  let {
    record,
    error,
    onsubmit,
    oncancel,
  }: {
    record: QuestionRecord
    error?: string
    onsubmit: (answers: Record<string, string>) => Promise<void>
    oncancel: () => Promise<void>
  } = $props()

  const OTHER = -1
  const valid = $derived(
    record.status === 'pending' &&
      record.questions.length >= 1 &&
      record.questions.length <= 4 &&
      record.questions.every(
        (question) =>
          question.question.length > 0 &&
          question.header.length > 0 &&
          question.options.length >= 2 &&
          question.options.length <= 4
      )
  )
  let choices = $state<number[][]>([])
  let otherText = $state<string[]>([])
  let busy = $state(false)
  let localError = $state('')

  function selected(questionIndex: number, optionIndex: number): boolean {
    return choices[questionIndex]?.includes(optionIndex) ?? false
  }

  function choose(questionIndex: number, optionIndex: number, multiSelect: boolean): void {
    const current = choices[questionIndex] ?? []
    const next = multiSelect
      ? current.includes(optionIndex)
        ? current.filter((value) => value !== optionIndex)
        : [...current, optionIndex]
      : [optionIndex]
    const nextChoices = Array.from(
      { length: record.questions.length },
      (_, index) => choices[index] ?? []
    )
    nextChoices[questionIndex] = next
    choices = nextChoices
    localError = ''
  }

  function setOther(questionIndex: number, value: string): void {
    const nextText = Array.from(
      { length: record.questions.length },
      (_, index) => otherText[index] ?? ''
    )
    nextText[questionIndex] = value
    otherText = nextText
    localError = ''
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (busy || !valid) return
    const entries: Array<[string, string]> = []
    for (let questionIndex = 0; questionIndex < record.questions.length; questionIndex += 1) {
      const question = record.questions[questionIndex]!
      const selectedOptions = choices[questionIndex] ?? []
      if (selectedOptions.length === 0) {
        localError = 'Answer every question before submitting.'
        return
      }
      const values: string[] = []
      for (const optionIndex of selectedOptions) {
        if (optionIndex === OTHER) {
          const custom = otherText[questionIndex]?.trim() ?? ''
          if (!custom) {
            localError = 'Enter an Other answer before submitting.'
            return
          }
          values.push(custom)
        } else {
          const label = question.options[optionIndex]?.label
          if (!label) {
            localError = 'This question changed unexpectedly; reload before answering.'
            return
          }
          values.push(label)
        }
      }
      entries.push([question.question, values.join(', ')])
    }

    busy = true
    localError = ''
    try {
      // CreateDataProperty semantics preserve exact "__proto__" and "constructor" question keys.
      await onsubmit(Object.fromEntries(entries))
    } catch (cause) {
      localError = cause instanceof Error ? cause.message : 'The answers could not be submitted.'
    } finally {
      busy = false
    }
  }

  async function cancel(): Promise<void> {
    if (busy || !valid) return
    busy = true
    localError = ''
    try {
      await oncancel()
    } catch (cause) {
      localError = cause instanceof Error ? cause.message : 'The question could not be cancelled.'
    } finally {
      busy = false
    }
  }
</script>

{#if !valid}
  <div class="question-card invalid" role="alert">
    Cannot display this question safely. No answer was submitted.
  </div>
{:else}
  <form class="question-card" onsubmit={submit} aria-label="Question from Claude">
    <div class="question-top">
      <span class="question-label">QUESTION FROM CLAUDE</span>
      <span class="question-count">{record.questions.length} {record.questions.length === 1 ? 'question' : 'questions'}</span>
    </div>

    {#each record.questions as question, questionIndex}
      <fieldset aria-label={`${question.header}: ${question.question}`}>
        <legend>
          <span class="header">{question.header}</span>
          <span class="prompt">{question.question}</span>
        </legend>
        <div class="options">
          {#each question.options as option, optionIndex}
            <label class="option">
              <input
                type={question.multiSelect ? 'checkbox' : 'radio'}
                aria-label={option.label}
                name={`question-${record.id}-${questionIndex}`}
                checked={selected(questionIndex, optionIndex)}
                onchange={() => choose(questionIndex, optionIndex, question.multiSelect)}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
                {#if option.preview}<pre class="preview">{option.preview}</pre>{/if}
              </span>
            </label>
          {/each}
          <label class="option">
            <input
              type={question.multiSelect ? 'checkbox' : 'radio'}
              aria-label="Other"
              name={`question-${record.id}-${questionIndex}`}
              checked={selected(questionIndex, OTHER)}
              onchange={() => choose(questionIndex, OTHER, question.multiSelect)}
            />
            <span><strong>Other</strong><small>Enter a different answer.</small></span>
          </label>
          {#if selected(questionIndex, OTHER)}
            <input
              class="other"
              aria-label="Other answer"
              value={otherText[questionIndex] ?? ''}
              oninput={(event) =>
                setOther(questionIndex, (event.currentTarget as HTMLInputElement).value)}
              autocomplete="off"
            />
          {/if}
        </div>
      </fieldset>
    {/each}

    <div class="actions">
      <button class="submit" type="submit" disabled={busy}>Submit answers</button>
      <button type="button" disabled={busy} onclick={cancel}>Cancel question</button>
    </div>
    {#if localError || error}
      <div class="error" role="alert">{localError || error}</div>
    {/if}
  </form>
{/if}

<style>
  .question-card {
    display: grid;
    gap: 12px;
    padding: 14px;
    border: 1px solid color-mix(in srgb, var(--secondary) 45%, var(--border));
    border-radius: 10px;
    background: color-mix(in srgb, var(--secondary) 7%, var(--surface));
  }
  .question-top, .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .question-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .08em;
    color: var(--secondary);
  }
  .question-count {
    color: var(--muted);
    font-size: 12px;
  }
  fieldset {
    min-width: 0;
    margin: 0;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  legend {
    display: grid;
    gap: 3px;
    max-width: 100%;
    padding: 0 5px;
  }
  .header {
    color: var(--muted);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .prompt {
    overflow-wrap: anywhere;
  }
  .options {
    display: grid;
    gap: 8px;
  }
  .option {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    cursor: pointer;
  }
  .option span {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .option small {
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .preview {
    max-height: 120px;
    margin: 4px 0 0;
    padding: 6px;
    overflow: auto;
    border-radius: 5px;
    background: var(--surface);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .other {
    width: 100%;
    box-sizing: border-box;
  }
  .actions button {
    padding: 6px 10px;
  }
  .submit {
    color: var(--surface);
    background: var(--secondary);
  }
  .error, .invalid {
    color: var(--danger);
  }
</style>
