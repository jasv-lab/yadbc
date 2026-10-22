{{- define "yadbc-broker.name" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "yadbc-broker.labels" -}}
app.kubernetes.io/name: yadbc-broker
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "yadbc-broker.selector" -}}
app.kubernetes.io/name: yadbc-broker
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
