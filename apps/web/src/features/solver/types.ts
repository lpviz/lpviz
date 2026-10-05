type ResultTextBlockClassName = "iterate-header" | "iterate-item" | "iterate-item-nohover" | "iterate-footer";

export type ResultTextBlock = {
  className: ResultTextBlockClassName;
  text: string;
  index?: number | undefined;
};
