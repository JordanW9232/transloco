import {
  ChangeDetectorRef,
  Directive,
  ElementRef,
  EmbeddedViewRef,
  inject,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Renderer2,
  SimpleChanges,
  TemplateRef,
  ViewContainerRef,
} from '@angular/core';
import { forkJoin, Observable, Subscription, switchMap } from 'rxjs';

import { Content, TemplateHandler } from './template-handler';
import { TRANSLOCO_LANG } from './transloco-lang';
import { TRANSLOCO_LOADING_TEMPLATE } from './transloco-loading-template';
import { TRANSLOCO_SCOPE } from './transloco-scope';
import { TranslocoService } from './transloco.service';
import { HashMap, OrArray, Translation, TranslocoScope } from './types';
import {
  listenOrNotOperator,
  resolveInlineLoader,
  shouldListenToLangChanges,
} from './shared';
import { LangResolver } from './lang-resolver';
import { ScopeResolver } from './scope-resolver';

type TranslateFn = (key: string, params?: HashMap) => any;
interface ViewContext {
  $implicit: TranslateFn;
  currentLang: string;
}

@Directive({
  selector: '[transloco]',
  standalone: true,
})
export class TranslocoDirective implements OnInit, OnDestroy, OnChanges {
  private service = inject(TranslocoService);
  private tpl = inject<TemplateRef<ViewContext>>(TemplateRef, {
    optional: true,
  });
  private providerLang = inject(TRANSLOCO_LANG, { optional: true });
  private providerScope: OrArray<TranslocoScope> | null = inject(
    TRANSLOCO_SCOPE,
    { optional: true }
  );
  private providedLoadingTpl = inject(TRANSLOCO_LOADING_TEMPLATE, {
    optional: true,
  });
  private cdr = inject(ChangeDetectorRef);
  private host = inject(ElementRef);
  private vcr = inject(ViewContainerRef);
  private renderer = inject(Renderer2);

  subscription: Subscription | null = null;
  view: EmbeddedViewRef<ViewContext> | undefined;

  private translationMemo: Record<string, { value: any; params?: HashMap }> =
    {};

  @Input('transloco') key: string | undefined;
  @Input('translocoParams') params: HashMap = {};
  @Input('translocoScope') inlineScope: string | undefined;
  @Input('translocoRead') inlineRead: string | undefined;
  @Input('translocoLang') inlineLang: string | undefined;
  @Input('translocoLoadingTpl') inlineTpl: Content | undefined;

  private currentLang: string | undefined;
  private loaderTplHandler: TemplateHandler | undefined;
  // Whether we already rendered the view once
  private initialized = false;
  private path: string | undefined;
  private langResolver = new LangResolver();
  private scopeResolver = new ScopeResolver(this.service);
  private readonly strategy = this.tpl === null ? 'attribute' : 'structural';

  static ngTemplateContextGuard(
    dir: TranslocoDirective,
    ctx: unknown
  ): ctx is ViewContext {
    return true;
  }

  ngOnInit() {
    const listenToLangChange = shouldListenToLangChanges(
      this.service,
      this.providerLang || this.inlineLang
    );

    this.subscription = this.service.langChanges$
      .pipe(
        switchMap((activeLang) => {
          const lang = this.langResolver.resolve({
            inline: this.inlineLang,
            provider: this.providerLang,
            active: activeLang,
          });

          return Array.isArray(this.providerScope)
            ? forkJoin(
                this.providerScope.map((providerScope) =>
                  this.resolveScope(lang, providerScope)
                )
              )
            : this.resolveScope(lang, this.providerScope);
        }),
        listenOrNotOperator(listenToLangChange)
      )
      .subscribe(() => {
        this.currentLang = this.langResolver.resolveLangBasedOnScope(
          this.path!
        );
        this.strategy === 'attribute'
          ? this.attributeStrategy()
          : this.structuralStrategy(this.currentLang, this.inlineRead);
        this.cdr.markForCheck();
        this.initialized = true;
      });

    if (!this.initialized) {
      const loadingContent = this.resolveLoadingContent();
      if (loadingContent) {
        this.loaderTplHandler = new TemplateHandler(loadingContent, this.vcr);
        this.loaderTplHandler.attachView();
      }
    }
  }

  ngOnChanges(changes: SimpleChanges) {
    // We need to support dynamic keys/params, so if this is not the first change CD cycle
    // we need to run the function again in order to update the value
    if (this.strategy === 'attribute') {
      const notInit = Object.keys(changes).some((v) => !changes[v].firstChange);
      notInit && this.attributeStrategy();
    }
  }

  private attributeStrategy() {
    this.detachLoader();
    this.renderer.setProperty(
      this.host.nativeElement,
      'innerText',
      this.service.translate(this.key!, this.params, this.currentLang)
    );
  }

  private structuralStrategy(lang: string, read?: string) {
    this.translationMemo = {};

    if (this.view) {
      // when the lang changes we need to change the reference so Angular will update the view
      this.view.context['$implicit'] = this.getTranslateFn(lang, read);
      this.view.context['currentLang'] = this.currentLang!;
    } else {
      this.detachLoader();
      this.view = this.vcr.createEmbeddedView(this.tpl!, {
        $implicit: this.getTranslateFn(lang, read),
        currentLang: this.currentLang!,
      });
    }
  }

  protected getTranslateFn(
    lang: string,
    read: string | undefined
  ): TranslateFn {
    return (key: string, params?: HashMap) => {
      const withRead = read ? `${read}.${key}` : key;
      const withParams = params
        ? `${withRead}${JSON.stringify(params)}`
        : withRead;

      if (
        Object.prototype.hasOwnProperty.call(this.translationMemo, withParams)
      ) {
        return this.translationMemo[withParams].value;
      }

      this.translationMemo[withParams] = {
        params,
        value: this.service.translate(withRead, params, lang),
      };

      return this.translationMemo[withParams].value;
    };
  }

  private resolveLoadingContent() {
    return this.inlineTpl || this.providedLoadingTpl;
  }

  ngOnDestroy() {
    if (this.subscription) {
      this.subscription.unsubscribe();
      // Caretaker note: it's important to clean up references to subscriptions since they save the `next`
      // callback within its `destination` property, preventing classes from being GC'd.
      this.subscription = null;
    }
  }

  private detachLoader() {
    this.loaderTplHandler?.detachView();
  }

  private resolveScope(
    lang: string,
    providerScope: TranslocoScope | null
  ): Observable<Translation | Translation[]> {
    const resolvedScope = this.scopeResolver.resolve({
      inline: this.inlineScope,
      provider: providerScope,
    });
    this.path = this.langResolver.resolveLangPath(lang, resolvedScope);
    const inlineLoader = resolveInlineLoader(providerScope, resolvedScope);

    return this.service._loadDependencies(this.path, inlineLoader);
  }
}
