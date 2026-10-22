# Build from the repository root: docker build -f src/Yadbc.Broker/Dockerfile -t <registry>/yadbc-broker:<tag> .
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY src/Yadbc.Contracts/Yadbc.Contracts.csproj src/Yadbc.Contracts/
COPY src/Yadbc.Broker/Yadbc.Broker.csproj src/Yadbc.Broker/
RUN dotnet restore src/Yadbc.Broker/Yadbc.Broker.csproj
COPY src/Yadbc.Contracts/ src/Yadbc.Contracts/
COPY src/Yadbc.Broker/ src/Yadbc.Broker/
RUN dotnet publish src/Yadbc.Broker/Yadbc.Broker.csproj -c Release -o /app --no-restore

# Chiseled: no shell, no package manager, non-root (uid 1654) by default.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled
WORKDIR /app
COPY --from=build /app .
ENV ASPNETCORE_URLS=http://+:8080 \
    Broker__DataDir=/data
EXPOSE 8080
ENTRYPOINT ["dotnet", "Yadbc.Broker.dll"]
