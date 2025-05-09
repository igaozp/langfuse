import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { Input } from "@/src/components/ui/input";
import { Button } from "@/src/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/src/components/ui/form";
import { api } from "@/src/utils/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { extractVariables, getIsCharOrUnderscore } from "@langfuse/shared";
import router from "next/router";
import { type EvalTemplate } from "@langfuse/shared";
import { ModelParameters } from "@/src/components/ModelParameters";
import {
  OutputSchema,
  type UIModelParams,
  type ModelParams,
  ZodModelConfig,
} from "@langfuse/shared";
import { PromptVariableListPreview } from "@/src/features/prompts/components/PromptVariableListPreview";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import { TEMPLATES } from "@/src/ee/features/evals/components/templates";
import { usePostHogClientCapture } from "@/src/features/posthog-analytics/usePostHogClientCapture";
import { getFinalModelParams } from "@/src/ee/utils/getFinalModelParams";
import { useModelParams } from "@/src/ee/features/playground/page/hooks/useModelParams";
import { showSuccessToast } from "@/src/features/notifications/showSuccessToast";
import { RadioGroup, RadioGroupItem } from "@/src/components/ui/radio-group";
import { EvalReferencedEvaluators } from "@/src/ee/features/evals/types";
import { CodeMirrorEditor } from "@/src/components/editor";

export const EvalTemplateForm = (props: {
  projectId: string;
  existingEvalTemplate?: EvalTemplate;
  onFormSuccess?: () => void;
  isEditing?: boolean;
  setIsEditing?: (isEditing: boolean) => void;
  preventRedirect?: boolean;
}) => {
  const [langfuseTemplate, setLangfuseTemplate] = useState<string | null>(null);

  const updateLangfuseTemplate = (name: string) => {
    setLangfuseTemplate(name);
  };

  const currentTemplate = TEMPLATES.find(
    (template) => template.name === langfuseTemplate,
  );

  return (
    <div className="grid grid-cols-1 gap-6 gap-x-12 lg:grid-cols-3">
      {props.isEditing ? (
        <div className="col-span-1 lg:col-span-2">
          <Select
            value={langfuseTemplate ?? ""}
            onValueChange={updateLangfuseTemplate}
          >
            <SelectTrigger className="text-primary ring-transparent focus:ring-0 focus:ring-offset-0">
              <SelectValue
                className="text-sm font-semibold text-primary"
                placeholder={"Select a Langfuse managed template (optional)"}
              />
            </SelectTrigger>
            <SelectContent className="max-h-60 max-w-80">
              {TEMPLATES.sort((a, b) => a.name.localeCompare(b.name)).map(
                (project) => (
                  <SelectItem key={project.name} value={project.name}>
                    {project.name}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <div className="col-span-1 lg:col-span-3">
        <InnerEvalTemplateForm
          key={langfuseTemplate ?? props.existingEvalTemplate?.id}
          {...props}
          existingEvalTemplateId={props.existingEvalTemplate?.id}
          existingEvalTemplateName={props.existingEvalTemplate?.name}
          preFilledFormValues={
            // if a langfuse template is selected, use that, else use the existing template
            // no langfuse template is selected if there is already an existing template
            langfuseTemplate
              ? {
                  name: langfuseTemplate.toLocaleLowerCase() ?? "",
                  prompt: currentTemplate?.prompt.trim() ?? "",
                  vars: [],
                  outputSchema: {
                    score: currentTemplate?.outputScore?.trim() ?? "",
                    reasoning: currentTemplate?.outputReasoning?.trim() ?? "",
                  },
                }
              : props.existingEvalTemplate
                ? {
                    name: props.existingEvalTemplate.name,
                    prompt: props.existingEvalTemplate.prompt,
                    vars: props.existingEvalTemplate.vars,
                    outputSchema: props.existingEvalTemplate.outputSchema as {
                      score: string;
                      reasoning: string;
                    },
                    selectedModel: {
                      provider: props.existingEvalTemplate.provider,
                      model: props.existingEvalTemplate.model,
                      modelParams: props.existingEvalTemplate
                        .modelParams as ModelParams & {
                        maxTemperature: number;
                      },
                    },
                  }
                : undefined
          }
        />
      </div>
    </div>
  );
};

const selectedModelSchema = z.object({
  provider: z.string().min(1, "Select a provider"),
  model: z.string().min(1, "Select a model"),
  modelParams: ZodModelConfig,
});

const formSchema = z.object({
  name: z.string().min(1, "Enter a name"),
  prompt: z
    .string()
    .min(1, "Enter a prompt")
    .refine((val) => {
      const variables = extractVariables(val);
      const matches = variables.map((variable) => {
        // check regex here
        if (variable.match(/^[A-Za-z_]+$/)) {
          return true;
        }
        return false;
      });
      return !matches.includes(false);
    }, "Variables must only contain letters and underscores (_)"),

  variables: z.array(
    z.string().min(1, "Variables must have at least one character"),
  ),
  outputScore: z.string().min(1, "Enter a score function"),
  outputReasoning: z.string().min(1, "Enter a reasoning function"),
  referencedEvaluators: z
    .nativeEnum(EvalReferencedEvaluators)
    .optional()
    .default(EvalReferencedEvaluators.PERSIST),
});

export type EvalTemplateFormPreFill = {
  name: string;
  prompt: string;
  vars: string[];
  outputSchema: {
    score: string;
    reasoning: string;
  };
  selectedModel?: {
    provider: string;
    model: string;
    modelParams: ModelParams & {
      maxTemperature: number;
    };
  };
};

export const InnerEvalTemplateForm = (props: {
  projectId: string;
  // pre-filled values from langfuse-defined template or template from db
  preFilledFormValues?: EvalTemplateFormPreFill;
  // template to be updated
  existingEvalTemplateId?: string;
  existingEvalTemplateName?: string;
  onFormSuccess?: () => void;
  isEditing?: boolean;
  setIsEditing?: (isEditing: boolean) => void;
  preventRedirect?: boolean;
}) => {
  const capture = usePostHogClientCapture();
  const [formError, setFormError] = useState<string | null>(null);

  // updates the model params based on the pre-filled data
  // either form update or from langfuse-generated template
  const {
    modelParams,
    setModelParams,
    updateModelParamValue,
    setModelParamEnabled,
    availableModels,
    availableProviders,
  } = useModelParams();

  useEffect(() => {
    if (props.preFilledFormValues?.selectedModel) {
      const { provider, model, modelParams } =
        props.preFilledFormValues.selectedModel;

      const modelConfig = Object.entries(modelParams).reduce(
        (acc, [key, value]) => {
          return {
            ...acc,
            [key]: { value, enabled: true },
          };
        },
        {} as UIModelParams,
      );

      setModelParams((prev) => ({
        ...prev,
        ...modelConfig,
        provider: { value: provider, enabled: true },
        model: { value: model, enabled: true },
      }));
    }
  }, [props.preFilledFormValues?.selectedModel, setModelParams]);

  // updates the form based on the pre-filled data
  // either form update or from langfuse-generated template
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    disabled: !props.isEditing,
    defaultValues: {
      name:
        props.existingEvalTemplateName ?? props.preFilledFormValues?.name ?? "",
      prompt: props.preFilledFormValues?.prompt ?? undefined,
      variables: props.preFilledFormValues?.vars ?? [],
      outputReasoning: props.preFilledFormValues
        ? OutputSchema.parse(props.preFilledFormValues?.outputSchema).reasoning
        : undefined,
      outputScore: props.preFilledFormValues
        ? OutputSchema.parse(props.preFilledFormValues?.outputSchema).score
        : undefined,
    },
  });

  const extractedVariables = form.watch("prompt")
    ? extractVariables(form.watch("prompt")).filter(getIsCharOrUnderscore)
    : undefined;

  const utils = api.useUtils();
  const createEvalTemplateMutation = api.evals.createTemplate.useMutation({
    onSuccess: () => {
      utils.models.invalidate();
      if (
        form.getValues("referencedEvaluators") ===
          EvalReferencedEvaluators.UPDATE &&
        props.existingEvalTemplateId
      ) {
        showSuccessToast({
          title: "Updated evaluators",
          description:
            "Updated referenced evaluators to use new template version.",
        });
      }
    },
    onError: (error) => setFormError(error.message),
  });

  const evaluatorsByTemplateNameQuery =
    api.evals.jobConfigsByTemplateName.useQuery(
      {
        projectId: props.projectId,
        evalTemplateName: props.existingEvalTemplateName as string,
      },
      {
        enabled: !!props.existingEvalTemplateName,
      },
    );

  useEffect(() => {
    if (evaluatorsByTemplateNameQuery.data) {
      form.setValue(
        "referencedEvaluators",
        Boolean(evaluatorsByTemplateNameQuery.data.evaluators.length)
          ? EvalReferencedEvaluators.UPDATE
          : EvalReferencedEvaluators.PERSIST,
      );
    }
  }, [evaluatorsByTemplateNameQuery.data, form]);

  function onSubmit(values: z.infer<typeof formSchema>) {
    capture(
      props.isEditing
        ? "eval_templates:update_form_submit"
        : "eval_templates:new_form_submit",
    );

    const evalTemplate = {
      name: values.name,
      projectId: props.projectId,
      prompt: values.prompt,
      provider: modelParams.provider.value,
      model: modelParams.model.value,
      modelParams: getFinalModelParams(modelParams),
      vars: extractedVariables ?? [],
      outputSchema: {
        score: values.outputScore,
        reasoning: values.outputReasoning,
      },
      referencedEvaluators: values.referencedEvaluators,
    };

    const parsedModel = selectedModelSchema.safeParse(evalTemplate);

    if (!parsedModel.success) {
      setFormError(
        `${parsedModel.error.errors[0].path}: ${parsedModel.error.errors[0].message}`,
      );
      return;
    }

    createEvalTemplateMutation
      .mutateAsync(evalTemplate)
      .then((res) => {
        props.onFormSuccess?.();
        form.reset();
        props.setIsEditing?.(false);
        if (props.preventRedirect) {
          return;
        }
        void router.push(
          `/project/${props.projectId}/evals/templates/${res.id}`,
        );
      })
      .catch((error) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if ("message" in error && typeof error.message === "string") {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          setFormError(error.message as string);
          return;
        } else {
          setFormError(JSON.stringify(error));
          console.error(error);
        }
      });
  }
  return (
    <Form {...form}>
      <form
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        onSubmit={form.handleSubmit(onSubmit)}
        className="grid grid-cols-1 gap-6 gap-x-12 lg:grid-cols-3"
      >
        {!props.existingEvalTemplateId ? (
          <>
            <div className="col-span-1 row-span-1 lg:col-span-2">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <>
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          placeholder="Select a template name"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  </>
                )}
              />
            </div>
            <div className="lg:col-span-0 col-span-1 row-span-1"></div>
          </>
        ) : undefined}

        <div className="col-span-1 flex flex-col gap-6 lg:col-span-2">
          <FormField
            control={form.control}
            name="prompt"
            render={({ field }) => (
              <>
                <FormItem>
                  <FormLabel>Prompt</FormLabel>
                  <FormDescription>
                    Define your llm-as-a-judge evaluation template. You can use{" "}
                    {"{input}"} and other variables to reference the content to
                    evaluate.
                  </FormDescription>
                  <FormControl>
                    <CodeMirrorEditor
                      value={field.value}
                      onChange={field.onChange}
                      editable={props.isEditing}
                      mode="prompt"
                      minHeight={200}
                    />
                  </FormControl>
                  <FormMessage />
                  <PromptVariableListPreview
                    variables={extractedVariables ?? []}
                  />
                </FormItem>
              </>
            )}
          />

          <FormField
            control={form.control}
            name="outputReasoning"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Reasoning</FormLabel>
                <FormDescription>
                  Define how the LLM should explain its evaluation. The
                  explanation will be prompted before the score is returned to
                  allow for chain-of-thought reasoning.
                </FormDescription>
                <FormControl>
                  <Input
                    placeholder="One sentence reasoning for the score"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="outputScore"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Score</FormLabel>
                <FormDescription>
                  Define how the LLM should return the evaluation score in
                  natural language. Needs to yield a numeric value.
                </FormDescription>
                <FormControl>
                  <Input {...field} placeholder="Score between 0 and 1" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {props.isEditing && props.existingEvalTemplateId && (
            <FormField
              control={form.control}
              name="referencedEvaluators"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Referenced evaluators</FormLabel>
                  <FormDescription>
                    {evaluatorsByTemplateNameQuery.data?.evaluators.length ?? 0}{" "}
                    evaluator(s) are currently using this template.
                    {Boolean(
                      evaluatorsByTemplateNameQuery.data?.evaluators.length,
                    )
                      ? " Choose how to handle existing evaluators with this update."
                      : " No evaluators to update."}
                  </FormDescription>
                  <FormControl>
                    <RadioGroup
                      {...field}
                      onValueChange={field.onChange}
                      defaultValue={
                        Boolean(
                          evaluatorsByTemplateNameQuery.data?.evaluators.length,
                        )
                          ? EvalReferencedEvaluators.UPDATE
                          : EvalReferencedEvaluators.PERSIST
                      }
                      disabled={
                        !Boolean(
                          evaluatorsByTemplateNameQuery.data?.evaluators.length,
                        )
                      }
                      className="flex flex-col space-y-1"
                    >
                      <FormItem className="flex items-center space-x-3 space-y-0">
                        <FormControl>
                          <RadioGroupItem value="update" />
                        </FormControl>
                        <FormLabel className="font-normal">
                          Update all to use new template version
                        </FormLabel>
                      </FormItem>
                      <FormItem className="flex items-center space-x-3 space-y-0">
                        <FormControl>
                          <RadioGroupItem value="persist" />
                        </FormControl>
                        <FormLabel className="font-normal">
                          Persist existing template version
                        </FormLabel>
                      </FormItem>
                    </RadioGroup>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
          {!props.isEditing && (
            <>
              <FormLabel>Referenced evaluators</FormLabel>
              <FormDescription>
                {evaluatorsByTemplateNameQuery.data?.evaluators.length ?? 0}{" "}
                evaluator(s) are currently using this template.
              </FormDescription>
            </>
          )}
        </div>
        <div className="col-span-1 row-span-3">
          <div className="flex flex-col gap-6">
            <ModelParameters
              {...{
                modelParams,
                availableModels,
                availableProviders,
                updateModelParamValue: updateModelParamValue,
                setModelParamEnabled,
                modelParamsDescription:
                  "Select a model which supports function calling.",
              }}
              formDisabled={!props.isEditing}
            />
          </div>
        </div>

        {props.isEditing && (
          <Button
            type="submit"
            loading={createEvalTemplateMutation.isLoading}
            className="col-span-1 lg:col-span-3"
          >
            Save
          </Button>
        )}
      </form>
      {formError ? (
        <p className="text-red text-center">
          <span className="font-bold">Error:</span> {formError}
        </p>
      ) : null}
    </Form>
  );
};
