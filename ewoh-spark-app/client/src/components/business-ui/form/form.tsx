import React from 'react';
import type { AppFieldExtendedReactFormApi } from '@tanstack/react-form';

import { FormProvider } from '@client/src/components/business-ui/form/context';
import { FieldGroup } from '@client/src/components/ui/field';

/**
 * CLI-332：Form 是纯展示外壳，接受任意 AppForm 实例、不关心表单数据形状。
 * 将 14 个内联 any 收敛为一个命名别名（tanstack 官方 createFormHook 用法
 * 对展示组件的推荐形态），避免在公开 Props 上堆叠裸 any。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAppFormApi = AppFieldExtendedReactFormApi<
  any, any, any, any, any, any, any, any, any, any, any, any, any, any
>;

interface FormProps {
  children: React.ReactNode;
  form: AnyAppFormApi;
  className?: string;
  style?: React.CSSProperties;
  layout?: 'vertical' | 'responsive' | 'horizontal';
}

const ForceForm: React.FC<FormProps> = (props) => {
  const { children, form, className, style, layout = 'vertical' } = props;
  return (
    <FormProvider layout={layout}>
      <form
        data-testid="tanstack-form"
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          form.handleSubmit();
        }}
      >
        <form.AppForm>
          <FieldGroup className={className} style={style}>
            {children}
          </FieldGroup>
        </form.AppForm>
      </form>
    </FormProvider>
  );
};

const Form = ForceForm;

export { Form };
